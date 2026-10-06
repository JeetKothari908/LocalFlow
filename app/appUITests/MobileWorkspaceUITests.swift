import XCTest
import UIKit

final class MobileWorkspaceUITests: XCTestCase {
    override func setUpWithError() throws { continueAfterFailure = false }

    @MainActor private func restartWeb(_ application: XCUIApplication) {
        let generation = application.staticTexts["web-generation"]
        let next = (Int(generation.label) ?? 0) + 1
        application.buttons["Test workspace"].tap()
        application.buttons["Simulate web process restart"].tap()
        let reloaded = XCTNSPredicateExpectation(predicate: NSPredicate(format: "label == %@", String(next)), object: generation)
        XCTAssertEqual(XCTWaiter.wait(for: [reloaded], timeout: 15), .completed)
    }

    @MainActor private func launch() -> XCUIApplication {
        let application = XCUIApplication()
        application.launchArguments = ["-mobile.useSharedInterface", "YES", "-sync.serverURL", "", "-sync.authToken", "", "-mobileTestControls"]
        application.launch()
        XCTAssertTrue(application.webViews.firstMatch.waitForExistence(timeout: 15))
        return application
    }

    @MainActor func testSharedTaskCreationAndOfflineRelaunch() throws {
        let application = launch()
        application.buttons["Tasks"].firstMatch.tap()
        let close = application.webViews.buttons["Close task workspace"]
        if close.waitForExistence(timeout: 2) { close.tap() }
        let field = application.webViews.textFields["New top level task"]
        XCTAssertTrue(field.waitForExistence(timeout: 10))
        field.tap()
        let name = "Offline task \(UUID().uuidString.prefix(8))"
        field.typeText(name + "\n")
        let task = application.webViews.buttons[name].firstMatch
        XCTAssertTrue(task.waitForExistence(timeout: 10))
        let saved = application.webViews.staticTexts.matching(NSPredicate(format: "label CONTAINS %@", "Saved locally")).firstMatch
        XCTAssertTrue(saved.waitForExistence(timeout: 10))
        application.terminate()
        application.launch()
        XCTAssertTrue(application.webViews.buttons[name].firstMatch.waitForExistence(timeout: 15))
        application.webViews.buttons[name].firstMatch.tap()
        XCTAssertTrue(application.webViews.buttons["Close task workspace"].waitForExistence(timeout: 5))
    }

    @MainActor func testNotesFoldersAndNativeAlertsRemainAccessible() throws {
        let application = launch()
        application.buttons["Notes"].firstMatch.tap()
        let newFolder = application.webViews.buttons["New folder"]
        XCTAssertTrue(newFolder.waitForExistence(timeout: 10))
        newFolder.tap()
        XCTAssertTrue(application.webViews.textFields.firstMatch.waitForExistence(timeout: 5))
        application.buttons["Alerts"].firstMatch.tap()
        XCTAssertTrue(application.navigationBars["Notifications"].waitForExistence(timeout: 5))
        application.buttons["Plan"].firstMatch.tap()
        XCTAssertTrue(application.webViews.textViews["Plan contents"].waitForExistence(timeout: 10))
    }

    @MainActor func testNativeRouteSurvivesWebRestartAndColdRelaunch() throws {
        let application = launch()
        application.buttons["Notes"].firstMatch.tap()
        application.buttons["Test workspace"].tap()
        application.buttons["Open fixture notification"].tap()
        let close = application.webViews.buttons["Close task workspace"]
        XCTAssertTrue(close.waitForExistence(timeout: 10))
        restartWeb(application)
        XCTAssertTrue(close.waitForExistence(timeout: 15))
        application.terminate(); application.launch()
        XCTAssertTrue(close.waitForExistence(timeout: 15))
        XCTAssertTrue(application.webViews.staticTexts["Native route fixture"].firstMatch.exists)
        if UIDevice.current.userInterfaceIdiom == .pad {
            XCTAssertTrue(application.webViews.textFields["New top level task"].isHittable)
        }
        close.tap()
    }

    @MainActor func testPlanDraftSurvivesTabChangeWebRestartAndOfflineRelaunch() throws {
        let application = launch()
        application.buttons["Plan"].firstMatch.tap()
        let editor = application.webViews.textViews["Plan contents"]
        XCTAssertTrue(editor.waitForExistence(timeout: 10))
        editor.tap()
        let text = " Plan \(UUID().uuidString.prefix(8))"
        editor.typeText(text)
        let saved = application.webViews.staticTexts.matching(NSPredicate(format: "label CONTAINS %@", "Saved locally")).firstMatch
        XCTAssertTrue(saved.waitForExistence(timeout: 10))
        application.buttons["Notes"].firstMatch.tap()
        application.buttons["Plan"].firstMatch.tap()
        XCTAssertTrue((editor.value as? String)?.contains(text) == true)
        restartWeb(application)
        XCTAssertTrue(editor.waitForExistence(timeout: 15))
        XCTAssertTrue((editor.value as? String)?.contains(text) == true)
        application.terminate(); application.launch()
        XCTAssertTrue(editor.waitForExistence(timeout: 15))
        XCTAssertTrue((editor.value as? String)?.contains(text) == true)
    }
}
