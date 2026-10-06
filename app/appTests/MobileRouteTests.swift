import XCTest
@testable import app

@MainActor final class MobileRouteTests: XCTestCase {
    func testNativeEventsRestoreTheDeliveredRouteFromEveryTab() throws {
        let suite = "LocalFlow-route-tests-\(UUID().uuidString)"
        let defaults = try XCTUnwrap(UserDefaults(suiteName: suite))
        defer { defaults.removePersistentDomain(forName: suite) }
        for tab in 0...3 {
            let state = MobileRouteState(defaults: defaults)
            state.selectTab(tab); state.selectTask("previous")
            state.openTask("notification-task")
            let event = try XCTUnwrap(state.pending)
            let coldLaunch = MobileRouteState(defaults: defaults)
            XCTAssertEqual(coldLaunch.pending?.taskId, "notification-task")
            XCTAssertFalse(coldLaunch.acknowledge("stale-event"))
            XCTAssertTrue(coldLaunch.acknowledge(event.id))
            let webRestart = MobileRouteState(defaults: defaults)
            XCTAssertEqual(webRestart.lastTask, "notification-task")
            XCTAssertEqual(webRestart.lastTab, 0)
            XCTAssertNil(webRestart.pending)
        }
    }
    func testOldAcknowledgmentCannotConsumeANewerEvent() throws {
        let suite = "LocalFlow-route-tests-\(UUID().uuidString)"
        let defaults = try XCTUnwrap(UserDefaults(suiteName: suite))
        defer { defaults.removePersistentDomain(forName: suite) }
        let state = MobileRouteState(defaults: defaults)
        state.openTask("first"); let first = try XCTUnwrap(state.pending)
        state.openTask("second")
        XCTAssertFalse(state.acknowledge(first.id))
        XCTAssertEqual(state.pending?.taskId, "second")
    }
}
