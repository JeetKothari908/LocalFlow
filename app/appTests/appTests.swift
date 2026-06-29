//
//  appTests.swift
//  appTests
//
//  Created by Jeet Kothari on 5/31/26.
//

import XCTest
@testable import app

final class appTests: XCTestCase {

    override func setUpWithError() throws {
        // Put setup code here. This method is called before the invocation of each test method in the class.
    }

    override func tearDownWithError() throws {
        // Put teardown code here. This method is called after the invocation of each test method in the class.
    }

    func testRemoteSnapshotDecodesVersionMetadata() throws {
        let data = Data(
            """
            {"changes":[{"key":"data/default-todo","value":{"items":[]},"version":7,"updatedAt":123}]}
            """.utf8
        )
        let snapshot = try JSONDecoder().decode(RemoteSnapshot.self, from: data)

        XCTAssertEqual(snapshot.changes.first?.key, "data/default-todo")
        XCTAssertEqual(snapshot.changes.first?.version, 7)
        XCTAssertEqual(snapshot.changes.first?.updatedAt, 123)
    }

    func testRemoteWriteResponseDecodesVersions() throws {
        let data = Data(
            """
            {"ok":true,"versions":{"data/default-notes":4},"requestId":"request-1"}
            """.utf8
        )
        let response = try JSONDecoder().decode(RemoteWriteResponse.self, from: data)

        XCTAssertTrue(response.ok)
        XCTAssertEqual(response.versions?["data/default-notes"], 4)
        XCTAssertEqual(response.requestId, "request-1")
    }

    func testPerformanceExample() throws {
        // This is an example of a performance test case.
        measure {
            // Put the code you want to measure the time of here.
        }
    }

}
