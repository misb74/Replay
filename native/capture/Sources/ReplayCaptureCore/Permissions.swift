import Foundation

public enum PermissionKind: String, Codable, CaseIterable, Equatable, Hashable, Sendable {
    case screenRecording = "screen_recording"
    case accessibility
    case inputMonitoring = "input_monitoring"
    case microphone
}

public enum PermissionState: String, Codable, Equatable, Sendable {
    case granted
    case denied
    case notDetermined = "not_determined"
    case restricted
    case unknown
}

public struct PermissionSnapshot: Codable, Equatable, Sendable {
    public var states: [PermissionKind: PermissionState]

    public init(states: [PermissionKind: PermissionState]) {
        self.states = states
    }

    public subscript(_ permission: PermissionKind) -> PermissionState {
        states[permission] ?? .unknown
    }

    private enum CodingKeys: String, CodingKey {
        case states
    }

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        let raw = try container.decode([String: PermissionState].self, forKey: .states)
        states = Dictionary(uniqueKeysWithValues: raw.compactMap { key, value in
            PermissionKind(rawValue: key).map { ($0, value) }
        })
    }

    public func encode(to encoder: Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        let raw = Dictionary(uniqueKeysWithValues: states.map { ($0.key.rawValue, $0.value) })
        try container.encode(raw, forKey: .states)
    }
}

public protocol PermissionProviding: AnyObject, Sendable {
    func snapshot() async -> PermissionSnapshot
    func request(_ permission: PermissionKind) async -> PermissionState
    func openSystemSettings(for permission: PermissionKind) async throws
}
