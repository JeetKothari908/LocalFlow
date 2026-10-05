import SwiftUI

struct ContentView: View {
    @EnvironmentObject private var store: SyncStore
    @State private var selectedTab = 0
    @Environment(\.scenePhase) private var scenePhase
    @EnvironmentObject private var notifications: TodoNotificationStore

    var body: some View {
        TabView(selection: $selectedTab) {
            TodoListView()
            .tabItem { Label("Tasks", systemImage: "checklist") }.tag(0)

            NavigationStack {
                NotesView()
            }
            .tabItem {
                Label("Notes", systemImage: "note.text")
            }.tag(1)

            NavigationStack {
                PlanOfDayView()
            }
            .tabItem {
                Label("Plan", systemImage: "calendar")
            }.tag(2)

            NavigationStack {
                NotificationSettingsView()
            }
            .tabItem {
                Label("Alerts", systemImage: "bell.badge")
            }.tag(3)
        }
        .task(id: scenePhase) {
            guard scenePhase == .active else { return }
            await store.refresh(); await notifications.rescheduleIfEnabled(todos: store.todos.items)
            while !Task.isCancelled {
                do { try await Task.sleep(for: .seconds(30)) } catch { break }
                guard !Task.isCancelled, scenePhase == .active else { break }
                await store.refresh()
            }
        }
        .onChange(of: store.todos) { _, tasks in Task { await notifications.rescheduleIfEnabled(todos: tasks.items) } }
        .onReceive(NotificationCenter.default.publisher(for: .openLocalFlowTask)) { event in
            if let id = event.userInfo?["taskId"] as? String { selectedTab = 0; store.taskToOpen = id }
        }
        .onOpenURL { url in
            if url.scheme == "localflow", url.host == "task", let id = url.pathComponents.dropFirst().first { selectedTab = 0; store.taskToOpen = id }
        }
    }
}

struct SyncToolbar: ToolbarContent {
    var body: some ToolbarContent {
        ToolbarItem(placement: .topBarTrailing) {
            SyncButtons()
        }
    }
}

private struct SyncButtons: View {
    @EnvironmentObject private var store: SyncStore
    @State private var settingsOpen = false

    var body: some View {
        HStack(spacing: 14) {
            Button {
                Task { await store.refresh() }
            } label: {
                Image(systemName: "arrow.clockwise")
            }
            .allowsHitTesting(!store.isSyncing)

            Button {
                settingsOpen = true
            } label: {
                Image(systemName: "gearshape")
            }
        }
        .sheet(isPresented: $settingsOpen) {
            SyncSettingsView()
                .environmentObject(store)
        }
    }
}

#Preview {
    ContentView()
        .environmentObject(SyncStore())
        .environmentObject(TodoNotificationStore())
}
