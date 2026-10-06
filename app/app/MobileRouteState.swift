import Foundation

/// A native event remains pending until the web recipient acknowledges its ID.
final class MobileRouteState {
    private let defaults: UserDefaults
    init(defaults: UserDefaults = .standard) { self.defaults = defaults }
    var lastTab: Int { ["tasks", "notes", "plan", "alerts"].firstIndex(of: defaults.string(forKey: "mobile.lastRoute") ?? "tasks") ?? 0 }
    var lastTask: String? { defaults.string(forKey: "mobile.lastTask") }
    var pending: (id: String, taskId: String)? {
        guard let task = defaults.string(forKey: "todo.pendingTaskId") else { return nil }
        let id = defaults.string(forKey: "mobile.pendingEventId") ?? UUID().uuidString
        defaults.set(id, forKey: "mobile.pendingEventId")
        return (id, task)
    }
    func selectTab(_ index: Int) {
        guard (0...3).contains(index) else { return }
        defaults.set(["tasks", "notes", "plan", "alerts"][index], forKey: "mobile.lastRoute")
    }
    func selectTask(_ id: String?) { defaults.set(id, forKey: "mobile.lastTask") }
    func openTask(_ id: String) {
        defaults.set(UUID().uuidString, forKey: "mobile.pendingEventId")
        defaults.set(id, forKey: "todo.pendingTaskId")
    }
    @discardableResult func acknowledge(_ id: String) -> Bool {
        guard let pending, pending.id == id else { return false }
        // Persist the delivered route before removing its restart recovery record.
        selectTask(pending.taskId); selectTab(0)
        defaults.removeObject(forKey: "todo.pendingTaskId")
        defaults.removeObject(forKey: "mobile.pendingEventId")
        return true
    }
}
