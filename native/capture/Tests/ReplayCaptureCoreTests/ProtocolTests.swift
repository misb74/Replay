import Foundation
import Testing
@testable import ReplayCaptureCore

@Test func recordCommandRoundTrips() throws {
    let command = SidecarCommandEnvelope(
        requestId: "request-1",
        command: .record(.init(
            sessionId: "session-1",
            sessionDirectory: "/tmp/session-1",
            includeAudio: true,
            display: .init(width: 1728, height: 1117, scale: 2)
        ))
    )

    let decoded = try JSONDecoder.replay.decode(
        SidecarCommandEnvelope.self,
        from: JSONEncoder.replay.encode(command)
    )

    #expect(decoded == command)
}

@Test func everyCommandDiscriminantDecodes() throws {
    let fixtures = [
        #"{"protocolVersion":1,"requestId":"1","command":"stop","payload":{"sessionId":"s"}}"#,
        #"{"protocolVersion":1,"requestId":"2","command":"status","payload":{}}"#,
        #"{"protocolVersion":1,"requestId":"3","command":"permissions","payload":{"operation":"status"}}"#,
        #"{"protocolVersion":1,"requestId":"4","command":"act_screenshot","payload":{"outputPath":"/tmp/a.png"}}"#,
        #"{"protocolVersion":1,"requestId":"5","command":"act_click","payload":{"position":{"x":12,"y":30},"button":"left","clickCount":1}}"#,
        #"{"protocolVersion":1,"requestId":"6","command":"act_type","payload":{"text":"hello"}}"#,
        #"{"protocolVersion":1,"requestId":"7","command":"heartbeat","payload":{"nonce":"abc"}}"#,
        #"{"protocolVersion":1,"requestId":"8","command":"guardrails_subscribe","payload":{"killSwitch":{"keyCode":53,"modifiers":["control","option","command"]},"mouseMovementThreshold":3}}"#,
        #"{"protocolVersion":1,"requestId":"9","command":"guardrails_unsubscribe","payload":{}}"#,
        #"{"protocolVersion":1,"requestId":"10","command":"act_key","payload":{"keyCode":36,"modifiers":[],"repeatCount":1}}"#,
        #"{"protocolVersion":1,"requestId":"11","command":"act_scroll","payload":{"deltaX":0,"deltaY":500}}"#,
        #"{"protocolVersion":1,"requestId":"12","command":"act_drag","payload":{"start":{"x":1,"y":2},"end":{"x":3,"y":4},"button":"left","durationMs":300}}"#,
        #"{"protocolVersion":1,"requestId":"13","command":"act_navigate","payload":{"url":"http://localhost:3000/invoices"}}"#
    ]

    for fixture in fixtures {
        _ = try JSONDecoder.replay.decode(
            SidecarCommandEnvelope.self,
            from: Data(fixture.utf8)
        )
    }
}

@Test func unsolicitedSafetyEventHasNoRequestId() throws {
    let envelope = SidecarEventEnvelope(.init(
        type: .userMouseMoved,
        timestampMs: 123,
        position: .init(x: 4, y: 5)
    ))

    let data = try JSONEncoder.replay.encode(envelope)
    let object = try #require(JSONSerialization.jsonObject(with: data) as? [String: Any])

    #expect(object["event"] as? String == "user_mouse_moved")
    #expect(object["requestId"] == nil)
}

@Test func unsupportedProtocolVersionIsRejected() {
    let fixture = #"{"protocolVersion":2,"requestId":"1","command":"status","payload":{}}"#

    #expect(throws: ProtocolError.unsupportedVersion(2)) {
        try JSONDecoder.replay.decode(
            SidecarCommandEnvelope.self,
            from: Data(fixture.utf8)
        )
    }
}

@Test func clickRequiresCoordinatesOrSemanticTarget() {
    let fixture = #"{"protocolVersion":1,"requestId":"1","command":"act_click","payload":{"button":"left","clickCount":1}}"#

    #expect(throws: (any Error).self) {
        try JSONDecoder.replay.decode(
            SidecarCommandEnvelope.self,
            from: Data(fixture.utf8)
        )
    }
}

@Test func errorResponseDoesNotEchoSensitiveCommandPayload() throws {
    let response = SidecarResponse.failure(
        requestId: "request-1",
        code: .secureFieldRequiresHumanInput,
        message: "Secure fields must be typed by the user."
    )
    let json = try #require(String(data: JSONEncoder.replay.encode(response), encoding: .utf8))

    #expect(!json.contains("secret-value"))
    #expect(json.contains("secure_field_requires_human_input"))
}
