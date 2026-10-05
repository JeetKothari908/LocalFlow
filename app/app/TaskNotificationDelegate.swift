import Foundation
import UserNotifications

extension Notification.Name {
    static let openLocalFlowTask = Notification.Name("LocalFlow.openTask")
}

@MainActor
final class TaskNotificationDelegate: NSObject, UNUserNotificationCenterDelegate {
    static let shared = TaskNotificationDelegate()
    nonisolated func userNotificationCenter(_ center: UNUserNotificationCenter, didReceive response: UNNotificationResponse, withCompletionHandler completionHandler: @escaping () -> Void) {
        let taskId = response.notification.request.content.userInfo["taskId"] as? String
        if let taskId { UserDefaults.standard.set(taskId, forKey: "todo.pendingTaskId"); Task { @MainActor in NotificationCenter.default.post(name: .openLocalFlowTask, object: nil, userInfo: ["taskId": taskId]) } }
        completionHandler()
    }
    nonisolated func userNotificationCenter(_ center: UNUserNotificationCenter, willPresent notification: UNNotification, withCompletionHandler completionHandler: @escaping (UNNotificationPresentationOptions) -> Void) {
        completionHandler([.banner, .sound])
    }
}
