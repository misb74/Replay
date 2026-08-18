import CoreGraphics
import Testing
@testable import ReplayCaptureMac
import ReplayCaptureCore

@Test func everyPermissionHasASettingsDeepLink() {
    for permission in PermissionKind.allCases {
        let url = MacSystemSettings.url(for: permission)
        #expect(url.scheme == "x-apple.systempreferences")
        #expect(!url.absoluteString.isEmpty)
    }
}

@Test func emergencyHotkeyStillWorksWithIncidentalModifierFlags() {
    let expected = KillSwitchHotkey.emergencyDefault.modifiers
    let required: CGEventFlags = [.maskControl, .maskAlternate, .maskCommand]

    #expect(MacSafetyMonitor.modifiersMatch(required, expected: expected))
    #expect(MacSafetyMonitor.modifiersMatch(
        required.union([.maskAlphaShift, .maskSecondaryFn]),
        expected: expected
    ))
    #expect(!MacSafetyMonitor.modifiersMatch(
        [.maskControl, .maskCommand],
        expected: expected
    ))
}

@Test func focusedTextInputSecurityFailsClosedForAnUnknownRole() {
    #expect(MacAccessibility.textInputSecurity(role: nil, subrole: nil) == .unknown)
    #expect(MacAccessibility.textInputSecurity(role: "", subrole: nil) == .unknown)
}

@Test func focusedTextInputSecurityRecognizesSecureRolesAndSubroles() {
    #expect(MacAccessibility.textInputSecurity(
        role: "AXSecureTextField",
        subrole: nil
    ) == .secure)
    #expect(MacAccessibility.textInputSecurity(
        role: "AXTextField",
        subrole: "AXSecureTextField"
    ) == .secure)
}

@Test func focusedTextInputSecurityAllowsKnownOrdinaryRoles() {
    #expect(MacAccessibility.textInputSecurity(
        role: "AXTextArea",
        subrole: nil
    ) == .nonSecure)
    #expect(MacAccessibility.textInputSecurity(
        role: "AXTextField",
        subrole: "AXSearchField"
    ) == .nonSecure)
}

@Test func targetedFocusRequiresTheOwningApplicationAndExactElement() {
    #expect(MacAccessibility.focusMatchesTarget(
        targetPID: 42,
        focusedApplicationPID: 42,
        elementsEqual: true
    ))
    #expect(!MacAccessibility.focusMatchesTarget(
        targetPID: 42,
        focusedApplicationPID: 43,
        elementsEqual: true
    ))
    #expect(!MacAccessibility.focusMatchesTarget(
        targetPID: 42,
        focusedApplicationPID: 42,
        elementsEqual: false
    ))
}

@Test func targetedFocusFailsClosedWithoutKnownProcessIdentifiers() {
    #expect(!MacAccessibility.focusMatchesTarget(
        targetPID: nil,
        focusedApplicationPID: 42,
        elementsEqual: true
    ))
    #expect(!MacAccessibility.focusMatchesTarget(
        targetPID: 42,
        focusedApplicationPID: nil,
        elementsEqual: true
    ))
}
