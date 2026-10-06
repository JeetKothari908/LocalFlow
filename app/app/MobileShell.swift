import SwiftUI

struct MobileShell: View {
    @EnvironmentObject private var store: SyncStore
    @EnvironmentObject private var notifications: TodoNotificationStore
    @Environment(\.scenePhase) private var scenePhase
    @AppStorage("mobile.useSharedInterface") private var useSharedInterface = true
    @StateObject private var coordinator: MobileWebCoordinator

    init(store: SyncStore) { _coordinator = StateObject(wrappedValue: MobileWebCoordinator(store: store)) }

    var body: some View {
        ZStack {
            MobileWebView(coordinator: coordinator)
                .opacity(coordinator.selectedTab == 3 ? 0 : 1)
                .allowsHitTesting(coordinator.selectedTab != 3)
                .accessibilityHidden(coordinator.selectedTab == 3)
            if coordinator.selectedTab == 3 {
                NavigationStack { NotificationSettingsView() }
                    .tint(Color.accentColor)
            }
            if let error = coordinator.loadError {
                ContentUnavailableView {
                    Label("Workspace unavailable", systemImage: "exclamationmark.triangle")
                } description: { Text(error) } actions: {
                    Button("Try again") { coordinator.load() }
                    Button("Use original interface") { useSharedInterface = false }
                }.background(.background)
            }
        }
        .safeAreaInset(edge: .bottom, spacing: 0) {
            HStack(spacing: 0) {
                tab("Tasks", icon: "checklist", index: 0)
                tab("Notes", icon: "note.text", index: 1)
                tab("Plan", icon: "calendar", index: 2)
                tab("Alerts", icon: "bell", index: 3)
            }.padding(.top, 8).padding(.bottom, 4).background(.bar)
        }
        .sheet(isPresented: $coordinator.settingsOpen) { SyncSettingsView().environmentObject(store) }
        .sheet(isPresented: Binding(get: { coordinator.shareURL != nil }, set: { if !$0 { coordinator.shareURL = nil } })) {
            if let url = coordinator.shareURL { MobileShareView(url: url) }
        }
        .task(id: scenePhase) {
            guard scenePhase == .active else { return }
            if let task = store.taskToOpen { coordinator.openTask(task) }
            await store.refresh()
            await notifications.rescheduleIfEnabled(todos: store.todos.items)
            while !Task.isCancelled {
                do { try await Task.sleep(for: .seconds(30)) } catch { break }
                guard scenePhase == .active, !Task.isCancelled else { break }
                await store.refresh()
            }
        }
        .onChange(of: store.todos) { _, data in Task { await notifications.rescheduleIfEnabled(todos: data.items) } }
        .onReceive(NotificationCenter.default.publisher(for: .openLocalFlowTask)) { event in
            if let id = event.userInfo?["taskId"] as? String { store.taskToOpen = id; coordinator.openTask(id) }
        }
        .onOpenURL { url in
            if url.scheme == "localflow", url.host == "task", let id = url.pathComponents.dropFirst().first { store.taskToOpen = id; coordinator.openTask(id) }
        }
        .overlay(alignment: .topLeading) {
            #if DEBUG
            if ProcessInfo.processInfo.arguments.contains("-mobileTestControls") {
                VStack(alignment: .leading) {
                Menu("Test workspace") {
                    Button("Simulate web process restart") { coordinator.webViewWebContentProcessDidTerminate(coordinator.webView) }
                    Button("Open fixture notification") {
                        if !store.todos.items.contains(where: { $0.id == "native-route-fixture" }) {
                            _ = store.mutateTasks { $0.items.append(TodoItem(id: "native-route-fixture", contents: "Native route fixture")) }
                        }
                        NotificationCenter.default.post(name: .openLocalFlowTask, object: nil, userInfo: ["taskId": "native-route-fixture"])
                    }
                }.buttonStyle(.borderedProminent)
                Text(String(coordinator.webGeneration)).accessibilityIdentifier("web-generation")
                }
            }
            #endif
        }
    }

    private func tab(_ title: String, icon: String, index: Int) -> some View {
        Button { coordinator.selectTab(index) } label: {
            VStack(spacing: 4) { Image(systemName: icon).font(.system(size: 20)); Text(title).font(.caption) }
                .frame(maxWidth: .infinity, minHeight: 44)
                .foregroundStyle(coordinator.selectedTab == index ? Color.accentColor : .secondary)
        }.buttonStyle(.plain).accessibilityAddTraits(coordinator.selectedTab == index ? [.isSelected] : [])
    }
}
