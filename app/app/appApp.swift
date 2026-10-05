//
//  appApp.swift
//  app
//
//  Created by Jeet Kothari on 5/31/26.
//

import SwiftUI
import UserNotifications

@main
struct appApp: App {
    @StateObject private var store = SyncStore()
    @StateObject private var notifications = TodoNotificationStore()

    init() { UNUserNotificationCenter.current().delegate = TaskNotificationDelegate.shared }

    var body: some Scene {
        WindowGroup {
            ContentView()
                .environmentObject(store)
                .environmentObject(notifications)
        }
    }
}
