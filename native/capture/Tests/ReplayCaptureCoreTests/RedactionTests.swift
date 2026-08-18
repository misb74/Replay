import Foundation
import Testing
@testable import ReplayCaptureCore

@Test func secureKeystrokeIsRedactedBeforeItBecomesCodable() throws {
    let raw = RawInputEvent.key(
        id: "event-1",
        sessionId: "session-1",
        timestampMs: 42,
        keyCode: 4,
        text: "hunter2",
        modifiers: []
    )
    let target = AccessibilityTarget(
        role: "AXSecureTextField",
        label: "Password",
        value: "hunter2",
        bounds: Rectangle(x: 10, y: 20, width: 200, height: 30),
        bundleId: "com.example.app",
        windowTitle: "Sign in",
        isSecure: true
    )

    let event = EventSanitizer.sanitize(raw, target: target)
    let data = try JSONEncoder.replay.encode(event)
    let json = try #require(String(data: data, encoding: .utf8))

    #expect(!json.contains("hunter2"))
    #expect(event.key?.text == Redaction.marker)
    #expect(event.key?.redacted == true)
    #expect(event.target?.value == Redaction.marker)
}

@Test func secureStatusComesFromRoleEvenIfProviderForgotFlag() {
    let target = AccessibilityTarget(
        role: "AXSecureTextField",
        value: "do-not-store",
        isSecure: false
    )
    let raw = RawInputEvent.key(
        id: "event-2",
        sessionId: "session-1",
        timestampMs: 0,
        keyCode: 0,
        text: "do-not-store",
        modifiers: []
    )

    let event = EventSanitizer.sanitize(raw, target: target)

    #expect(event.key?.text == Redaction.marker)
    #expect(event.target?.value == Redaction.marker)
    #expect(event.target?.isSecure == true)
}

@Test func secureStatusComesFromMacAccessibilitySubrole() {
    let target = AccessibilityTarget(
        role: "AXTextField",
        subrole: "AXSecureTextField",
        value: "subrole-secret"
    )
    let event = EventSanitizer.sanitize(
        .key(
            id: "event-subrole",
            sessionId: "session-1",
            timestampMs: 0,
            keyCode: 0,
            text: "subrole-secret",
            modifiers: []
        ),
        target: target
    )

    #expect(event.key?.text == Redaction.marker)
    #expect(event.target?.value == Redaction.marker)
}

@Test func secureTargetDiscardsReservedDOMContext() {
    let secret = "must-not-serialize"
    let event = EventSanitizer.sanitize(
        .click(
            id: "event-secure-click",
            sessionId: "session-1",
            timestampMs: 1,
            position: Point(x: 10, y: 10),
            button: .left,
            clickCount: 1
        ),
        target: AccessibilityTarget(
            role: "AXTextField",
            subrole: "AXSecureTextField",
            value: secret
        ),
        dom: DOMContext(selector: "[value='\(secret)']", name: secret)
    )

    #expect(event.target?.value == Redaction.marker)
    #expect(event.dom == nil)
}

@Test func nonSecureKeystrokeKeepsText() {
    let raw = RawInputEvent.key(
        id: "event-3",
        sessionId: "session-1",
        timestampMs: 1,
        keyCode: 0,
        text: "Q3 report",
        modifiers: [.shift]
    )
    let target = AccessibilityTarget(role: "AXTextField", label: "Search")

    let event = EventSanitizer.sanitize(raw, target: target)

    #expect(event.key?.text == "Q3 report")
    #expect(event.key?.redacted == false)
}

@Test func missingAccessibilityContextRedactsKeyTextConservatively() {
    let event = EventSanitizer.sanitize(
        .key(
            id: "event-unknown",
            sessionId: "session-1",
            timestampMs: 1,
            keyCode: 0,
            text: "possibly-secret",
            modifiers: []
        ),
        target: nil
    )

    #expect(event.key?.text == Redaction.marker)
    #expect(event.key?.redacted == true)
}

@Test func rawInputEventCannotAccidentallyUseGenericEncoder() {
    #expect(!(RawInputEvent.self is any Encodable.Type))
}

@Test func capturedEventEncoderDefendsAgainstUnsafeInternalConstruction() throws {
    let secret = "encoder-must-remove-this"
    let unsafe = CapturedEvent(
        id: "unsafe-internal",
        sessionId: "session-1",
        timestampMs: 1,
        type: .click,
        position: Point(x: 1, y: 2),
        target: AccessibilityTarget(
            role: "AXTextField",
            subrole: "AXSecureTextField",
            value: secret
        ),
        dom: DOMContext(selector: "[value='\(secret)']", name: secret)
    )

    let data = try JSONEncoder.replay.encode(unsafe)
    let json = try #require(String(data: data, encoding: .utf8))
    let encoded = try JSONDecoder.replay.decode(CapturedEvent.self, from: data)

    #expect(!json.contains(secret))
    #expect(encoded.target?.value == Redaction.marker)
    #expect(encoded.target?.isSecure == true)
    #expect(encoded.dom == nil)
}
