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

@Test func recordCommandCarriesExcludedProcessIds() throws {
    let command = SidecarCommandEnvelope(
        requestId: "request-exclusions",
        command: .record(.init(
            sessionId: "session-1",
            sessionDirectory: "/tmp/session-1",
            includeAudio: false,
            display: .init(width: 100, height: 50, scale: 1),
            excludeProcessIds: [4321]
        ))
    )

    let decoded = try JSONDecoder.replay.decode(
        SidecarCommandEnvelope.self,
        from: JSONEncoder.replay.encode(command)
    )

    #expect(decoded == command)
}

@Test func screenshotCommandDefaultsToNoExclusions() throws {
    let decoded = try JSONDecoder.replay.decode(
        SidecarCommandEnvelope.self,
        from: Data(#"{"protocolVersion":1,"requestId":"1","command":"act_screenshot","payload":{"outputPath":"/tmp/a.png"}}"#.utf8)
    )

    guard case let .actScreenshot(command) = decoded.command else {
        Issue.record("Expected a screenshot command")
        return
    }
    #expect(command.excludeProcessIds.isEmpty)
}

@Test func screenshotCommandDefaultsToCreatingDirectories() throws {
    let decoded = try JSONDecoder.replay.decode(
        SidecarCommandEnvelope.self,
        from: Data(#"{"protocolVersion":1,"requestId":"1","command":"act_screenshot","payload":{"outputPath":"/tmp/a.png"}}"#.utf8)
    )
    guard case let .actScreenshot(command) = decoded.command else {
        Issue.record("Expected a screenshot command")
        return
    }
    #expect(command.createDirectories)
}

@Test func screenshotCommandCarriesCreateDirectories() throws {
    let envelope = SidecarCommandEnvelope(
        requestId: "request-no-create",
        command: .actScreenshot(.init(outputPath: "/tmp/live/a.png", createDirectories: false))
    )
    let decoded = try JSONDecoder.replay.decode(
        SidecarCommandEnvelope.self,
        from: JSONEncoder.replay.encode(envelope)
    )
    #expect(decoded == envelope)
}

@Test func liveCommandsRoundTrip() throws {
    let commands: [SidecarCommand] = [
        .liveSpeak(.init(utteranceId: "utterance-1", text: "Both totals match.")),
        .liveStopSpeaking(.init()),
        .liveSetPaused(.init(paused: true)),
    ]

    for command in commands {
        let envelope = SidecarCommandEnvelope(requestId: "request-1", command: command)
        let decoded = try JSONDecoder.replay.decode(
            SidecarCommandEnvelope.self,
            from: JSONEncoder.replay.encode(envelope)
        )
        #expect(decoded == envelope)
    }
}

@Test func recordCommandCarriesLiveConfiguration() throws {
    let envelope = SidecarCommandEnvelope(
        requestId: "request-live",
        command: .record(.init(
            sessionId: "session-1",
            sessionDirectory: "/tmp/session-1",
            includeAudio: true,
            display: .init(width: 100, height: 50, scale: 1),
            live: .init(locale: "en-GB")
        ))
    )

    let decoded = try JSONDecoder.replay.decode(
        SidecarCommandEnvelope.self,
        from: JSONEncoder.replay.encode(envelope)
    )

    #expect(decoded == envelope)
    guard case let .record(command) = decoded.command else {
        Issue.record("Expected a record command")
        return
    }
    #expect(command.live?.locale == "en-GB")
}

@Test func livePrepareCommandRoundTrips() throws {
    let commands: [SidecarCommand] = [
        .livePrepare(.init()),
        .livePrepare(.init(locale: "en-GB")),
    ]

    for command in commands {
        let envelope = SidecarCommandEnvelope(requestId: "request-1", command: command)
        let decoded = try JSONDecoder.replay.decode(
            SidecarCommandEnvelope.self,
            from: JSONEncoder.replay.encode(envelope)
        )
        #expect(decoded == envelope)
    }
}

@Test func livePrepareResultTypesEncodeAsSnakeCase() throws {
    let preparing = try #require(
        JSONSerialization.jsonObject(
            with: JSONEncoder.replay.encode(SidecarResponseResult(type: .livePreparing))
        ) as? [String: Any]
    )
    let ready = try #require(
        JSONSerialization.jsonObject(
            with: JSONEncoder.replay.encode(SidecarResponseResult(type: .liveReady))
        ) as? [String: Any]
    )

    #expect(preparing["type"] as? String == "live_preparing")
    #expect(ready["type"] as? String == "live_ready")
}

@Test func liveEventsHaveNoRequestId() throws {
    let transcript = SidecarLiveEventEnvelope(
        event: .transcript,
        sessionId: "session-1",
        segmentId: "segment-1",
        text: "Any difference is flagged",
        isFinal: true,
        startMs: 1_200,
        endMs: 2_400
    )
    let object = try #require(
        JSONSerialization.jsonObject(with: JSONEncoder.replay.encode(transcript)) as? [String: Any]
    )

    #expect(object["event"] as? String == "live_transcript")
    #expect(object["requestId"] == nil)
    #expect(object["isFinal"] as? Bool == true)
}

@Test func liveStateEventCarriesAReason() throws {
    let envelope = SidecarLiveEventEnvelope(
        event: .state,
        sessionId: "session-1",
        state: .failed,
        reason: "microphone_unavailable"
    )
    let object = try #require(
        JSONSerialization.jsonObject(with: JSONEncoder.replay.encode(envelope)) as? [String: Any]
    )

    #expect(object["event"] as? String == "live_state")
    #expect(object["state"] as? String == "failed")
    #expect(object["reason"] as? String == "microphone_unavailable")
}

/// The desktop half keys on these exact strings. Nothing on this side
/// pinned them, so a rename here would have reached the panel as speech
/// that never starts or a state that never arrives.
@Test func speechPhasesEncodeAsTheNamesTheDesktopKeysOn() throws {
    let phases: [SidecarLiveSpeechPhase: String] = [
        .started: "started",
        .finished: "finished",
        .cancelled: "cancelled",
    ]
    for (phase, expected) in phases {
        let envelope = SidecarLiveEventEnvelope(
            event: .speech,
            sessionId: "session-1",
            utteranceId: "utterance-1",
            phase: phase,
            atMs: 0
        )
        let object = try #require(
            JSONSerialization.jsonObject(with: JSONEncoder.replay.encode(envelope)) as? [String: Any]
        )
        #expect(object["phase"] as? String == expected)
    }
}

@Test func liveStatesEncodeAsTheNamesTheDesktopKeysOn() throws {
    let states: [SidecarLiveState: String] = [
        .preparingModel: "preparing_model",
        .listening: "listening",
        .paused: "paused",
        .failed: "failed",
    ]
    for (state, expected) in states {
        let envelope = SidecarLiveEventEnvelope(
            event: .state,
            sessionId: "session-1",
            state: state
        )
        let object = try #require(
            JSONSerialization.jsonObject(with: JSONEncoder.replay.encode(envelope)) as? [String: Any]
        )
        #expect(object["state"] as? String == expected)
    }
}

@Test func speechEventEncodesAtMs() throws {
    let envelope = SidecarLiveEventEnvelope(
        event: .speech,
        sessionId: "session-1",
        utteranceId: "utterance-1",
        phase: .started,
        atMs: 1_234.5
    )
    let object = try #require(
        JSONSerialization.jsonObject(with: JSONEncoder.replay.encode(envelope)) as? [String: Any]
    )

    #expect(object["event"] as? String == "live_speech")
    #expect(object["atMs"] as? Double == 1_234.5)
}

@Test func transcriptAndStateEventsEncodeNoAtMsKey() throws {
    let transcript = SidecarLiveEventEnvelope(
        event: .transcript,
        sessionId: "session-1",
        segmentId: "segment-1",
        text: "Any difference is flagged",
        isFinal: true,
        startMs: 1_200,
        endMs: 2_400
    )
    let state = SidecarLiveEventEnvelope(
        event: .state,
        sessionId: "session-1",
        state: .listening
    )

    let transcriptObject = try #require(
        JSONSerialization.jsonObject(with: JSONEncoder.replay.encode(transcript)) as? [String: Any]
    )
    let stateObject = try #require(
        JSONSerialization.jsonObject(with: JSONEncoder.replay.encode(state)) as? [String: Any]
    )

    #expect(transcriptObject["atMs"] == nil)
    #expect(stateObject["atMs"] == nil)
}
