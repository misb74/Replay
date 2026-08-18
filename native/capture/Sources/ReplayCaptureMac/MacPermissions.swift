import AppKit
import ApplicationServices
import AVFoundation
import CoreGraphics
import Foundation
import ReplayCaptureCore

public enum MacSystemSettings {
    public static func url(for permission: PermissionKind) -> URL {
        let pane: String
        switch permission {
        case .screenRecording:
            pane = "Privacy_ScreenCapture"
        case .accessibility:
            pane = "Privacy_Accessibility"
        case .inputMonitoring:
            pane = "Privacy_ListenEvent"
        case .microphone:
            pane = "Privacy_Microphone"
        }
        return URL(string: "x-apple.systempreferences:com.apple.preference.security?\(pane)")!
    }
}

public final class MacPermissionProvider: PermissionProviding, Sendable {
    public init() {}

    public func snapshot() async -> PermissionSnapshot {
        PermissionSnapshot(states: [
            .screenRecording: CGPreflightScreenCaptureAccess() ? .granted : .denied,
            .accessibility: AXIsProcessTrusted() ? .granted : .denied,
            .inputMonitoring: CGPreflightListenEventAccess() ? .granted : .denied,
            .microphone: microphoneState()
        ])
    }

    public func request(_ permission: PermissionKind) async -> PermissionState {
        switch permission {
        case .screenRecording:
            _ = CGRequestScreenCaptureAccess()
        case .accessibility:
            let options = ["AXTrustedCheckOptionPrompt": true] as CFDictionary
            _ = AXIsProcessTrustedWithOptions(options)
        case .inputMonitoring:
            _ = CGRequestListenEventAccess()
        case .microphone:
            await withCheckedContinuation { continuation in
                AVCaptureDevice.requestAccess(for: .audio) { _ in
                    continuation.resume()
                }
            }
        }
        return await snapshot()[permission]
    }

    public func openSystemSettings(for permission: PermissionKind) async throws {
        let url = MacSystemSettings.url(for: permission)
        let opened = await MainActor.run {
            NSWorkspace.shared.open(url)
        }
        if !opened {
            throw SidecarOperationError.ioFailed
        }
    }

    private func microphoneState() -> PermissionState {
        switch AVCaptureDevice.authorizationStatus(for: .audio) {
        case .authorized: return .granted
        case .denied: return .denied
        case .notDetermined: return .notDetermined
        case .restricted: return .restricted
        @unknown default: return .unknown
        }
    }
}
