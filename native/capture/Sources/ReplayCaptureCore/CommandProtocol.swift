import Foundation

public let replayCaptureProtocolVersion = 1

public enum ProtocolError: Error, Equatable {
    case unsupportedVersion(Int)
    case unknownCommand(String)
    case invalidPayload(String)
}

public struct RecordCommand: Codable, Equatable, Sendable {
    public var sessionId: String
    public var sessionDirectory: String
    public var includeAudio: Bool
    public var display: DisplayInfo
    public var appVersions: [String: String]

    public init(
        sessionId: String,
        sessionDirectory: String,
        includeAudio: Bool,
        display: DisplayInfo,
        appVersions: [String: String] = [:]
    ) {
        self.sessionId = sessionId
        self.sessionDirectory = sessionDirectory
        self.includeAudio = includeAudio
        self.display = display
        self.appVersions = appVersions
    }

    private enum CodingKeys: String, CodingKey {
        case sessionId
        case sessionDirectory
        case includeAudio
        case display
        case appVersions
    }

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        sessionId = try container.decode(String.self, forKey: .sessionId)
        sessionDirectory = try container.decode(String.self, forKey: .sessionDirectory)
        includeAudio = try container.decodeIfPresent(Bool.self, forKey: .includeAudio) ?? false
        display = try container.decode(DisplayInfo.self, forKey: .display)
        appVersions = try container.decodeIfPresent([String: String].self, forKey: .appVersions) ?? [:]
    }
}

public struct StopCommand: Codable, Equatable, Sendable {
    public var sessionId: String?

    public init(sessionId: String? = nil) {
        self.sessionId = sessionId
    }
}

public struct StatusCommand: Codable, Equatable, Sendable {
    public init() {}
}

public enum PermissionOperation: String, Codable, Equatable, Sendable {
    case status
    case request
    case openSettings = "open_settings"
}

public struct PermissionsCommand: Codable, Equatable, Sendable {
    public var operation: PermissionOperation
    public var permission: PermissionKind?

    public init(operation: PermissionOperation = .status, permission: PermissionKind? = nil) {
        self.operation = operation
        self.permission = permission
    }

    private enum CodingKeys: String, CodingKey {
        case operation
        case permission
    }

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        operation = try container.decodeIfPresent(PermissionOperation.self, forKey: .operation) ?? .status
        permission = try container.decodeIfPresent(PermissionKind.self, forKey: .permission)
    }
}

public struct ElementSelector: Codable, Equatable, Sendable {
    public var identifier: String?
    public var role: String?
    public var subrole: String?
    public var label: String?
    public var bundleId: String?
    public var windowTitle: String?

    public init(
        identifier: String? = nil,
        role: String? = nil,
        subrole: String? = nil,
        label: String? = nil,
        bundleId: String? = nil,
        windowTitle: String? = nil
    ) {
        self.identifier = identifier
        self.role = role
        self.subrole = subrole
        self.label = label
        self.bundleId = bundleId
        self.windowTitle = windowTitle
    }
}

public struct ActScreenshotCommand: Codable, Equatable, Sendable {
    public var outputPath: String
    public var displayId: UInt32?

    public init(outputPath: String, displayId: UInt32? = nil) {
        self.outputPath = outputPath
        self.displayId = displayId
    }
}

public struct ActClickCommand: Codable, Equatable, Sendable {
    public var position: Point?
    public var target: ElementSelector?
    public var button: MouseButton
    public var clickCount: Int

    public init(
        position: Point? = nil,
        target: ElementSelector? = nil,
        button: MouseButton = .left,
        clickCount: Int = 1
    ) {
        self.position = position
        self.target = target
        self.button = button
        self.clickCount = clickCount
    }

    private enum CodingKeys: String, CodingKey {
        case position
        case target
        case button
        case clickCount
    }

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        position = try container.decodeIfPresent(Point.self, forKey: .position)
        target = try container.decodeIfPresent(ElementSelector.self, forKey: .target)
        button = try container.decodeIfPresent(MouseButton.self, forKey: .button) ?? .left
        clickCount = try container.decodeIfPresent(Int.self, forKey: .clickCount) ?? 1
        guard position != nil || target != nil else {
            throw ProtocolError.invalidPayload("act_click needs a position or target")
        }
        guard (1...3).contains(clickCount) else {
            throw ProtocolError.invalidPayload("clickCount must be between 1 and 3")
        }
    }
}

public struct ActTypeCommand: Codable, Equatable, Sendable {
    public var text: String
    public var target: ElementSelector?

    public init(text: String, target: ElementSelector? = nil) {
        self.text = text
        self.target = target
    }
}

public struct ActKeyCommand: Codable, Equatable, Sendable {
    public var keyCode: UInt16
    public var modifiers: [ModifierKey]
    public var repeatCount: Int

    public init(
        keyCode: UInt16,
        modifiers: [ModifierKey] = [],
        repeatCount: Int = 1
    ) {
        self.keyCode = keyCode
        self.modifiers = modifiers
        self.repeatCount = repeatCount
    }

    private enum CodingKeys: String, CodingKey {
        case keyCode
        case modifiers
        case repeatCount
    }

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        keyCode = try container.decode(UInt16.self, forKey: .keyCode)
        modifiers = try container.decodeIfPresent([ModifierKey].self, forKey: .modifiers) ?? []
        repeatCount = try container.decodeIfPresent(Int.self, forKey: .repeatCount) ?? 1
    }
}

public struct ActScrollCommand: Codable, Equatable, Sendable {
    public var deltaX: Double
    public var deltaY: Double
    public var position: Point?
    public var target: ElementSelector?

    public init(
        deltaX: Double,
        deltaY: Double,
        position: Point? = nil,
        target: ElementSelector? = nil
    ) {
        self.deltaX = deltaX
        self.deltaY = deltaY
        self.position = position
        self.target = target
    }
}

public struct ActDragCommand: Codable, Equatable, Sendable {
    public var start: Point
    public var end: Point
    public var button: MouseButton
    public var durationMs: Int

    public init(
        start: Point,
        end: Point,
        button: MouseButton = .left,
        durationMs: Int = 300
    ) {
        self.start = start
        self.end = end
        self.button = button
        self.durationMs = durationMs
    }

    private enum CodingKeys: String, CodingKey {
        case start
        case end
        case button
        case durationMs
    }

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        start = try container.decode(Point.self, forKey: .start)
        end = try container.decode(Point.self, forKey: .end)
        button = try container.decodeIfPresent(MouseButton.self, forKey: .button) ?? .left
        durationMs = try container.decodeIfPresent(Int.self, forKey: .durationMs) ?? 300
    }
}

public struct ActNavigateCommand: Codable, Equatable, Sendable {
    public var url: String
    public var bundleId: String?

    public init(url: String, bundleId: String? = nil) {
        self.url = url
        self.bundleId = bundleId
    }

    public var isValidHTTPURL: Bool {
        guard url.count <= 8_192,
              let components = URLComponents(string: url),
              let scheme = components.scheme?.lowercased(),
              ["http", "https"].contains(scheme),
              components.host != nil else {
            return false
        }
        return true
    }
}

public struct HeartbeatCommand: Codable, Equatable, Sendable {
    public var nonce: String?

    public init(nonce: String? = nil) {
        self.nonce = nonce
    }
}

public struct KillSwitchHotkey: Codable, Equatable, Sendable {
    public var keyCode: UInt16
    public var modifiers: [ModifierKey]

    /// Control-Option-Command-Escape. The extra Control avoids colliding with
    /// macOS's built-in Force Quit shortcut.
    public static let emergencyDefault = KillSwitchHotkey(
        keyCode: 53,
        modifiers: [.control, .option, .command]
    )

    public init(keyCode: UInt16, modifiers: [ModifierKey]) {
        self.keyCode = keyCode
        self.modifiers = modifiers
    }
}

public struct GuardrailsSubscribeCommand: Codable, Equatable, Sendable {
    public var killSwitch: KillSwitchHotkey
    public var mouseMovementThreshold: Double

    public init(
        killSwitch: KillSwitchHotkey = .emergencyDefault,
        mouseMovementThreshold: Double = 3
    ) {
        self.killSwitch = killSwitch
        self.mouseMovementThreshold = mouseMovementThreshold
    }

    private enum CodingKeys: String, CodingKey {
        case killSwitch
        case mouseMovementThreshold
    }

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        killSwitch = try container.decodeIfPresent(
            KillSwitchHotkey.self,
            forKey: .killSwitch
        ) ?? .emergencyDefault
        mouseMovementThreshold = try container.decodeIfPresent(
            Double.self,
            forKey: .mouseMovementThreshold
        ) ?? 3
    }
}

public struct GuardrailsUnsubscribeCommand: Codable, Equatable, Sendable {
    public init() {}
}

public enum SidecarCommand: Equatable, Sendable {
    case record(RecordCommand)
    case stop(StopCommand)
    case status(StatusCommand)
    case permissions(PermissionsCommand)
    case actScreenshot(ActScreenshotCommand)
    case actClick(ActClickCommand)
    case actType(ActTypeCommand)
    case actKey(ActKeyCommand)
    case actScroll(ActScrollCommand)
    case actDrag(ActDragCommand)
    case actNavigate(ActNavigateCommand)
    case heartbeat(HeartbeatCommand)
    case guardrailsSubscribe(GuardrailsSubscribeCommand)
    case guardrailsUnsubscribe(GuardrailsUnsubscribeCommand)

    fileprivate var name: String {
        switch self {
        case .record: return "record"
        case .stop: return "stop"
        case .status: return "status"
        case .permissions: return "permissions"
        case .actScreenshot: return "act_screenshot"
        case .actClick: return "act_click"
        case .actType: return "act_type"
        case .actKey: return "act_key"
        case .actScroll: return "act_scroll"
        case .actDrag: return "act_drag"
        case .actNavigate: return "act_navigate"
        case .heartbeat: return "heartbeat"
        case .guardrailsSubscribe: return "guardrails_subscribe"
        case .guardrailsUnsubscribe: return "guardrails_unsubscribe"
        }
    }
}

public struct SidecarCommandEnvelope: Codable, Equatable, Sendable {
    public var protocolVersion: Int
    public var requestId: String
    public var command: SidecarCommand

    public init(
        protocolVersion: Int = replayCaptureProtocolVersion,
        requestId: String,
        command: SidecarCommand
    ) {
        self.protocolVersion = protocolVersion
        self.requestId = requestId
        self.command = command
    }

    private enum CodingKeys: String, CodingKey {
        case protocolVersion
        case requestId
        case command
        case payload
    }

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        protocolVersion = try container.decode(Int.self, forKey: .protocolVersion)
        guard protocolVersion == replayCaptureProtocolVersion else {
            throw ProtocolError.unsupportedVersion(protocolVersion)
        }
        requestId = try container.decode(String.self, forKey: .requestId)
        let name = try container.decode(String.self, forKey: .command)
        let payloadDecoder = try container.superDecoder(forKey: .payload)

        switch name {
        case "record": command = .record(try RecordCommand(from: payloadDecoder))
        case "stop": command = .stop(try StopCommand(from: payloadDecoder))
        case "status": command = .status(try StatusCommand(from: payloadDecoder))
        case "permissions": command = .permissions(try PermissionsCommand(from: payloadDecoder))
        case "act_screenshot": command = .actScreenshot(try ActScreenshotCommand(from: payloadDecoder))
        case "act_click": command = .actClick(try ActClickCommand(from: payloadDecoder))
        case "act_type": command = .actType(try ActTypeCommand(from: payloadDecoder))
        case "act_key": command = .actKey(try ActKeyCommand(from: payloadDecoder))
        case "act_scroll": command = .actScroll(try ActScrollCommand(from: payloadDecoder))
        case "act_drag": command = .actDrag(try ActDragCommand(from: payloadDecoder))
        case "act_navigate": command = .actNavigate(try ActNavigateCommand(from: payloadDecoder))
        case "heartbeat": command = .heartbeat(try HeartbeatCommand(from: payloadDecoder))
        case "guardrails_subscribe":
            command = .guardrailsSubscribe(try GuardrailsSubscribeCommand(from: payloadDecoder))
        case "guardrails_unsubscribe":
            command = .guardrailsUnsubscribe(try GuardrailsUnsubscribeCommand(from: payloadDecoder))
        default: throw ProtocolError.unknownCommand(name)
        }
    }

    public func encode(to encoder: Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        try container.encode(protocolVersion, forKey: .protocolVersion)
        try container.encode(requestId, forKey: .requestId)
        try container.encode(command.name, forKey: .command)
        let payloadEncoder = container.superEncoder(forKey: .payload)

        switch command {
        case let .record(value): try value.encode(to: payloadEncoder)
        case let .stop(value): try value.encode(to: payloadEncoder)
        case let .status(value): try value.encode(to: payloadEncoder)
        case let .permissions(value): try value.encode(to: payloadEncoder)
        case let .actScreenshot(value): try value.encode(to: payloadEncoder)
        case let .actClick(value): try value.encode(to: payloadEncoder)
        case let .actType(value): try value.encode(to: payloadEncoder)
        case let .actKey(value): try value.encode(to: payloadEncoder)
        case let .actScroll(value): try value.encode(to: payloadEncoder)
        case let .actDrag(value): try value.encode(to: payloadEncoder)
        case let .actNavigate(value): try value.encode(to: payloadEncoder)
        case let .heartbeat(value): try value.encode(to: payloadEncoder)
        case let .guardrailsSubscribe(value): try value.encode(to: payloadEncoder)
        case let .guardrailsUnsubscribe(value): try value.encode(to: payloadEncoder)
        }
    }
}

public enum SidecarResultType: String, Codable, Equatable, Sendable {
    case recordingStarted = "recording_started"
    case recordingStopped = "recording_stopped"
    case status
    case permissions
    case screenshot
    case actionCompleted = "action_completed"
    case heartbeat
    case guardrailsSubscribed = "guardrails_subscribed"
    case guardrailsUnsubscribed = "guardrails_unsubscribed"
}

public enum SidecarRuntimeState: String, Codable, Equatable, Sendable {
    case idle
    case recording
}

public struct ScreenshotResult: Codable, Equatable, Sendable {
    public var path: String
    public var width: Int
    public var height: Int
    /// Screenshot pixels per macOS logical coordinate point.
    public var scale: Double

    public init(path: String, width: Int, height: Int, scale: Double) {
        self.path = path
        self.width = width
        self.height = height
        self.scale = scale
    }
}

public struct SidecarResponseResult: Codable, Equatable, Sendable {
    public var type: SidecarResultType
    public var state: SidecarRuntimeState?
    public var sessionId: String?
    public var eventCount: Int?
    public var partial: Bool?
    public var permissions: PermissionSnapshot?
    public var screenshot: ScreenshotResult?
    public var nonce: String?
    public var uptimeMs: Double?
    public var guardrailsActive: Bool?
    public var guardrailsTripped: Bool?
    public var captureHealthy: Bool?

    public init(
        type: SidecarResultType,
        state: SidecarRuntimeState? = nil,
        sessionId: String? = nil,
        eventCount: Int? = nil,
        partial: Bool? = nil,
        permissions: PermissionSnapshot? = nil,
        screenshot: ScreenshotResult? = nil,
        nonce: String? = nil,
        uptimeMs: Double? = nil,
        guardrailsActive: Bool? = nil,
        guardrailsTripped: Bool? = nil,
        captureHealthy: Bool? = nil
    ) {
        self.type = type
        self.state = state
        self.sessionId = sessionId
        self.eventCount = eventCount
        self.partial = partial
        self.permissions = permissions
        self.screenshot = screenshot
        self.nonce = nonce
        self.uptimeMs = uptimeMs
        self.guardrailsActive = guardrailsActive
        self.guardrailsTripped = guardrailsTripped
        self.captureHealthy = captureHealthy
    }
}

public enum SidecarSafetyEventType: String, Codable, Equatable, Sendable {
    case killSwitch = "kill_switch"
    case userMouseMoved = "user_mouse_moved"
}

public struct SidecarSafetyEvent: Equatable, Sendable {
    public var type: SidecarSafetyEventType
    public var timestampMs: Double
    public var position: Point?

    public init(type: SidecarSafetyEventType, timestampMs: Double, position: Point? = nil) {
        self.type = type
        self.timestampMs = timestampMs
        self.position = position
    }
}

/// Unsolicited JSONL message emitted after `guardrails_subscribe`. It has no
/// request ID, which keeps it unambiguous from request/response traffic.
public struct SidecarEventEnvelope: Codable, Equatable, Sendable {
    public var protocolVersion: Int
    public var event: SidecarSafetyEventType
    public var timestampMs: Double
    public var position: Point?

    public init(
        protocolVersion: Int = replayCaptureProtocolVersion,
        event: SidecarSafetyEventType,
        timestampMs: Double,
        position: Point? = nil
    ) {
        self.protocolVersion = protocolVersion
        self.event = event
        self.timestampMs = timestampMs
        self.position = position
    }

    public init(_ event: SidecarSafetyEvent) {
        self.init(event: event.type, timestampMs: event.timestampMs, position: event.position)
    }
}

public enum SidecarErrorCode: String, Codable, Equatable, Sendable {
    case invalidCommand = "invalid_command"
    case invalidState = "invalid_state"
    case permissionDenied = "permission_denied"
    case secureFieldRequiresHumanInput = "secure_field_requires_human_input"
    case safetyInterlockEngaged = "safety_interlock_engaged"
    case targetNotFound = "target_not_found"
    case captureFailed = "capture_failed"
    case ioFailed = "io_failed"
    case internalError = "internal_error"
}

public struct SidecarResponseError: Codable, Equatable, Sendable {
    public var code: SidecarErrorCode
    public var message: String

    public init(code: SidecarErrorCode, message: String) {
        self.code = code
        self.message = message
    }
}

public struct SidecarResponse: Codable, Equatable, Sendable {
    public var protocolVersion: Int
    public var requestId: String
    public var ok: Bool
    public var result: SidecarResponseResult?
    public var error: SidecarResponseError?

    public static func success(
        requestId: String,
        result: SidecarResponseResult
    ) -> SidecarResponse {
        SidecarResponse(
            protocolVersion: replayCaptureProtocolVersion,
            requestId: requestId,
            ok: true,
            result: result,
            error: nil
        )
    }

    public static func failure(
        requestId: String,
        code: SidecarErrorCode,
        message: String
    ) -> SidecarResponse {
        SidecarResponse(
            protocolVersion: replayCaptureProtocolVersion,
            requestId: requestId,
            ok: false,
            result: nil,
            error: SidecarResponseError(code: code, message: message)
        )
    }
}
