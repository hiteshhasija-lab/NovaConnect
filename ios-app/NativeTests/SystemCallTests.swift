import XCTest
@testable import NovaConnectNative

@MainActor final class FakeSystemCalls: SystemCalling {
    var answer: (() async -> Bool)?
    var end: (() async -> Void)?
    var mute: ((Bool) -> Void)?
    var reset: (() -> Void)?
    var incomingTitles: [String] = []
    var incomingVideo: [Bool] = []
    var finished = 0
    var rejectIncoming = false
    func outgoing(title: String, video: Bool) async throws {}
    func incoming(title: String, video: Bool) async throws {
        incomingTitles.append(title); incomingVideo.append(video)
        if rejectIncoming { throw APIError(message: "Call unavailable") }
    }
    func requestAnswer() async throws { _ = await answer?() }
    func requestEnd() async throws { await end?() }
    func requestMute(_ muted: Bool) async throws { mute?(muted) }
    func connected() {}
    func finish(failed: Bool) { finished += 1 }
}

@MainActor final class SystemCallTests: XCTestCase {
    func testBuiltAppDeclaresCallKitBackgroundModes() {
        let app = Bundle(for: SystemCalls.self)
        let modes = app.object(forInfoDictionaryKey: "UIBackgroundModes") as? [String] ?? []
        XCTAssertTrue(modes.contains("voip"), "CallKit rejects transactions without the voip background mode.")
        XCTAssertTrue(modes.contains("audio"), "Active calls require background audio.")
    }
    func testVideoIncomingUsesVideoSystemUIWithoutStartingCamera() async {
        let system = FakeSystemCalls(), live = LiveConnection()
        let calls = NativeCalls(system: system)
        calls.event(LiveEvent(name: "gcall:incoming", payload: ["id": "v", "title": "Eva", "mode": "video"]), live: live)
        for _ in 0..<5 { await Task.yield() }
        XCTAssertTrue(calls.video)
        XCTAssertEqual(calls.phase, "Incoming video call")
        XCTAssertEqual(system.incomingVideo, [true])
        XCTAssertFalse(calls.cameraOn)
        XCTAssertNil(calls.localTrack)
        calls.setForeground(false)
        XCTAssertTrue(calls.active, "Backgrounding must preserve the call while stopping camera capture.")
        XCTAssertFalse(calls.cameraOn)
        calls.event(LiveEvent(name: "gcall:ended", payload: ["id": "v"]), live: live)
        XCTAssertFalse(calls.active)
        XCTAssertTrue(calls.participants.isEmpty)
        XCTAssertNil(calls.localTrack)
    }
    func testCameraCannotStartBeforeCallAndCameraPermissionHasPurpose() async {
        let calls = NativeCalls(system: FakeSystemCalls())
        await calls.toggleCamera()
        XCTAssertFalse(calls.cameraOn)
        XCTAssertNil(calls.localTrack)
        let bundle = Bundle(for: SystemCalls.self)
        XCTAssertFalse((bundle.object(forInfoDictionaryKey: "NSCameraUsageDescription") as? String ?? "").isEmpty)
    }
    private func incoming(_ calls: NativeCalls, id: String = "first") {
        calls.event(LiveEvent(name: "gcall:incoming", payload: ["id": id, "title": "Eva", "mode": "audio"]), live: LiveConnection())
    }
    func testIncomingIsReportedOnlyOnceAndKeepsConnectionActive() async {
        let system = FakeSystemCalls()
        // Use an injected provider: no system calls or media are started by tests.
        let subject = NativeCalls(system: system)
        incoming(subject); incoming(subject)
        for _ in 0..<5 { await Task.yield() }
        XCTAssertEqual(system.incomingTitles, ["Eva"])
        XCTAssertTrue(subject.active)
        await subject.hangUp()
        XCTAssertFalse(subject.active)
        XCTAssertFalse(subject.visible)
    }
    func testRemoteEndBeforeReportDoesNotCreateGhostCall() async {
        let system = FakeSystemCalls()
        let subject = NativeCalls(system: system)
        incoming(subject)
        subject.event(LiveEvent(name: "gcall:ended", payload: ["id": "first"]), live: LiveConnection())
        for _ in 0..<5 { await Task.yield() }
        XCTAssertTrue(system.incomingTitles.isEmpty)
        XCTAssertFalse(subject.active)
    }
    func testSystemMuteAndEndUpdateInAppControls() async {
        let system = FakeSystemCalls()
        let calls = NativeCalls(system: system)
        incoming(calls)
        system.mute?(true)
        XCTAssertTrue(calls.muted)
        system.mute?(false)
        XCTAssertFalse(calls.muted)
        await system.end?()
        XCTAssertFalse(calls.active)
        XCTAssertFalse(calls.visible)
    }
    func testDeniedIncomingClearsCallState() async {
        let system = FakeSystemCalls(); system.rejectIncoming = true
        let calls = NativeCalls(system: system)
        incoming(calls)
        for _ in 0..<10 { await Task.yield() }
        XCTAssertFalse(calls.active)
        XCTAssertFalse(calls.incoming)
        XCTAssertNotNil(calls.error)
    }
    func testMalformedIncomingCannotRetainBackgroundConnection() {
        let calls = NativeCalls(system: FakeSystemCalls())
        calls.event(LiveEvent(name: "gcall:incoming", payload: ["mode": "audio"]), live: LiveConnection())
        XCTAssertFalse(calls.active)
        XCTAssertFalse(calls.visible)
    }
}
