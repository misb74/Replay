import Foundation
import Testing
@testable import ReplayCaptureCore

@Test func everyCapturedEventUsesTheCanonicalVersionedShape() throws {
    let sessionId = "session-schema"
    let target = AccessibilityTarget(
        role: "AXButton",
        subrole: "AXStandardWindow",
        label: "Approve",
        bounds: Rectangle(x: 1, y: 2, width: 30, height: 40),
        bundleId: "com.example.ReplayFixture",
        windowTitle: "Invoices",
        identifier: "approve-button"
    )
    let inputs: [(RawInputEvent, String)] = [
        (.click(
            id: "click",
            sessionId: sessionId,
            timestampMs: 1,
            position: Point(x: 10, y: 20),
            button: .left,
            clickCount: 2
        ), "click"),
        (.key(
            id: "key",
            sessionId: sessionId,
            timestampMs: 2,
            keyCode: 0,
            text: "a",
            modifiers: [.shift]
        ), "key"),
        (.scroll(
            id: "scroll",
            sessionId: sessionId,
            timestampMs: 3,
            position: Point(x: 11, y: 21),
            deltaX: 1,
            deltaY: -2
        ), "scroll"),
        (.drag(
            id: "drag",
            sessionId: sessionId,
            timestampMs: 4,
            start: Point(x: 1, y: 2),
            end: Point(x: 3, y: 4),
            button: .left
        ), "drag"),
        (.appSwitch(
            id: "app",
            sessionId: sessionId,
            timestampMs: 5
        ), "app_switch"),
        (.windowSwitch(
            id: "window",
            sessionId: sessionId,
            timestampMs: 6
        ), "window_switch")
    ]

    for (raw, expectedType) in inputs {
        let event = EventSanitizer.sanitize(raw, target: target)
        let data = try JSONEncoder.replay.encode(event)
        let object = try #require(JSONSerialization.jsonObject(with: data) as? [String: Any])

        #expect(object["schemaVersion"] as? Int == 1)
        #expect(object["sessionId"] as? String == sessionId)
        #expect(object["type"] as? String == expectedType)
        #expect(object["target"] != nil)
        #expect(try JSONDecoder.replay.decode(CapturedEvent.self, from: data) == event)
    }
}
