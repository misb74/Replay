import AppKit
import ApplicationServices
import Foundation
import ReplayCaptureCore

enum MacAccessibility {
    private static let secureTextFieldRole = "AXSecureTextField"

    enum TextInputSecurity: Equatable {
        case nonSecure
        case secure
        case unknown
    }

    static func snapshot(at point: CGPoint?) -> AccessibilityTarget? {
        let system = AXUIElementCreateSystemWide()
        let element: AXUIElement

        if let point {
            var found: AXUIElement?
            guard AXUIElementCopyElementAtPosition(
                system,
                Float(point.x),
                Float(point.y),
                &found
            ) == .success, let found else {
                return nil
            }
            element = found
        } else {
            guard let focused = focusedElement(system: system) else {
                return nil
            }
            element = focused
        }

        return snapshot(of: element)
    }

    static func focusedElementIsSecure() -> Bool {
        focusedElementSecurity() != .nonSecure
    }

    static func focusedElementIsSafeForTyping(matching expected: AXUIElement?) -> Bool {
        focusedElementSecurity(matching: expected) == .nonSecure
    }

    static func focusedElementSecurity(matching expected: AXUIElement? = nil) -> TextInputSecurity {
        guard let focused = focusedElementContext() else {
            // An unknown focus state is unsafe for automated typing. This is
            // intentionally conservative when AX is briefly unavailable.
            return .unknown
        }
        if let expected,
           !focusMatchesTarget(
               targetPID: processIdentifier(of: expected),
               focusedApplicationPID: processIdentifier(of: focused.application),
               elementsEqual: CFEqual(focused.element, expected)
           ) {
            // Focusing can fail without moving focus to the requested target.
            // Never accept some other ordinary field as proof that it is safe.
            return .unknown
        }
        return textInputSecurity(of: focused.element)
    }

    static func snapshot(of element: AXUIElement) -> AccessibilityTarget {
        let role: String? = copyAttribute(element, kAXRoleAttribute)
        let subrole: String? = copyAttribute(element, kAXSubroleAttribute)
        let secure = role == secureTextFieldRole || subrole == secureTextFieldRole

        let label: String? = firstNonempty([
            copyAttribute(element, kAXTitleAttribute),
            copyAttribute(element, kAXDescriptionAttribute),
            copyAttribute(element, kAXHelpAttribute)
        ])

        // Never ask Accessibility for a secure field's value. This keeps the
        // secret outside both the Codable model and diagnostic error paths.
        let value: String? = secure ? nil : stringValue(copyAttributeAny(element, kAXValueAttribute))
        let identifier: String? = copyAttribute(element, kAXIdentifierAttribute)
        let url = containingURL(of: element)
        let bounds = rectangle(of: element)

        var pid: pid_t = 0
        AXUIElementGetPid(element, &pid)
        let bundleId = NSRunningApplication(processIdentifier: pid)?.bundleIdentifier
        let windowTitle = containingWindowTitle(of: element)

        return AccessibilityTarget(
            role: role,
            subrole: subrole,
            label: label,
            value: value,
            bounds: bounds,
            bundleId: bundleId,
            windowTitle: windowTitle,
            url: url,
            identifier: identifier,
            isSecure: secure
        )
    }

    static func resolve(_ selector: ElementSelector) -> AXUIElement? {
        let applications: [NSRunningApplication]
        if let bundleId = selector.bundleId {
            applications = NSRunningApplication.runningApplications(withBundleIdentifier: bundleId)
        } else if let frontmost = NSWorkspace.shared.frontmostApplication {
            applications = [frontmost]
        } else {
            applications = []
        }

        for application in applications {
            let root = AXUIElementCreateApplication(application.processIdentifier)
            var visited = 0
            if let match = find(
                selector,
                in: root,
                depth: 0,
                visited: &visited
            ) {
                return match
            }
        }
        return nil
    }

    static func center(of element: AXUIElement) -> CGPoint? {
        guard let rectangle = rectangle(of: element) else { return nil }
        return CGPoint(
            x: rectangle.x + rectangle.width / 2,
            y: rectangle.y + rectangle.height / 2
        )
    }

    static func isSecure(_ element: AXUIElement) -> Bool {
        textInputSecurity(of: element) != .nonSecure
    }

    static func activateApplication(owning element: AXUIElement) -> Bool {
        guard let pid = processIdentifier(of: element),
              let application = NSRunningApplication(processIdentifier: pid) else {
            return false
        }
        // The PID comes from the resolved AX element, never from selector data.
        // Activation is asynchronous; the caller still has to verify global
        // focus before it may emit keyboard events.
        return application.activate(options: [])
    }

    static func focusMatchesTarget(
        targetPID: pid_t?,
        focusedApplicationPID: pid_t?,
        elementsEqual: Bool
    ) -> Bool {
        guard let targetPID, targetPID > 0,
              let focusedApplicationPID, focusedApplicationPID > 0 else {
            return false
        }
        return targetPID == focusedApplicationPID && elementsEqual
    }

    static func textInputSecurity(role: String?, subrole: String?) -> TextInputSecurity {
        guard let role, !role.isEmpty else { return .unknown }
        if role == secureTextFieldRole || subrole == secureTextFieldRole {
            return .secure
        }
        return .nonSecure
    }

    private static func textInputSecurity(of element: AXUIElement) -> TextInputSecurity {
        let role: String? = copyAttribute(element, kAXRoleAttribute)
        let subrole: String? = copyAttribute(element, kAXSubroleAttribute)
        return textInputSecurity(role: role, subrole: subrole)
    }

    private static func focusedElement(
        system: AXUIElement = AXUIElementCreateSystemWide()
    ) -> AXUIElement? {
        focusedElementContext(system: system)?.element
    }

    private static func focusedElementContext(
        system: AXUIElement = AXUIElementCreateSystemWide()
    ) -> (application: AXUIElement, element: AXUIElement)? {
        // AXFocusedUIElement is application-specific. Resolve the system-wide
        // focused application first, then ask that application for its focus.
        guard let application: AXUIElement = copyAttribute(
            system,
            kAXFocusedApplicationAttribute
        ) else {
            return nil
        }
        guard let element: AXUIElement = copyAttribute(
            application,
            kAXFocusedUIElementAttribute
        ) else {
            return nil
        }
        return (application, element)
    }

    private static func processIdentifier(of element: AXUIElement) -> pid_t? {
        var pid: pid_t = 0
        guard AXUIElementGetPid(element, &pid) == .success, pid > 0 else {
            return nil
        }
        return pid
    }

    private static func find(
        _ selector: ElementSelector,
        in element: AXUIElement,
        depth: Int,
        visited: inout Int
    ) -> AXUIElement? {
        guard depth <= 20, visited < 1_000 else { return nil }
        visited += 1

        let snapshot = snapshot(of: element)
        if matches(snapshot, selector: selector) {
            return element
        }

        let children: [AXUIElement] = copyAttribute(element, kAXChildrenAttribute) ?? []
        for child in children {
            if let found = find(selector, in: child, depth: depth + 1, visited: &visited) {
                return found
            }
        }
        return nil
    }

    private static func matches(_ target: AccessibilityTarget, selector: ElementSelector) -> Bool {
        if let expected = selector.identifier, target.identifier != expected { return false }
        if let expected = selector.role, target.role != expected { return false }
        if let expected = selector.subrole, target.subrole != expected { return false }
        if let expected = selector.label, target.label != expected { return false }
        if let expected = selector.bundleId, target.bundleId != expected { return false }
        if let expected = selector.windowTitle, target.windowTitle != expected { return false }
        return selector.identifier != nil
            || selector.role != nil
            || selector.subrole != nil
            || selector.label != nil
    }

    private static func rectangle(of element: AXUIElement) -> Rectangle? {
        guard let positionValue: AXValue = copyAttribute(element, kAXPositionAttribute),
              let sizeValue: AXValue = copyAttribute(element, kAXSizeAttribute) else {
            return nil
        }
        var position = CGPoint.zero
        var size = CGSize.zero
        guard AXValueGetValue(positionValue, .cgPoint, &position),
              AXValueGetValue(sizeValue, .cgSize, &size) else {
            return nil
        }
        return Rectangle(
            x: position.x,
            y: position.y,
            width: size.width,
            height: size.height
        )
    }

    private static func containingWindowTitle(of element: AXUIElement) -> String? {
        guard let window: AXUIElement = copyAttribute(element, kAXWindowAttribute) else {
            return nil
        }
        return copyAttribute(window, kAXTitleAttribute)
    }

    private static func containingURL(of element: AXUIElement) -> String? {
        var current: AXUIElement? = element
        var depth = 0
        while let candidate = current, depth < 20 {
            if let url = urlString(copyAttributeAny(candidate, kAXURLAttribute)) {
                return url
            }
            current = copyAttribute(candidate, kAXParentAttribute)
            depth += 1
        }
        return nil
    }

    private static func copyAttribute<T>(_ element: AXUIElement, _ name: String) -> T? {
        copyAttributeAny(element, name) as? T
    }

    private static func copyAttributeAny(_ element: AXUIElement, _ name: String) -> AnyObject? {
        var value: CFTypeRef?
        guard AXUIElementCopyAttributeValue(element, name as CFString, &value) == .success else {
            return nil
        }
        return value
    }

    private static func firstNonempty(_ values: [String?]) -> String? {
        values.compactMap { $0 }.first { !$0.isEmpty }
    }

    private static func stringValue(_ value: AnyObject?) -> String? {
        switch value {
        case let string as String: return string
        case let number as NSNumber: return number.stringValue
        default: return nil
        }
    }

    private static func urlString(_ value: AnyObject?) -> String? {
        switch value {
        case let url as URL: return url.absoluteString
        case let string as String: return string
        default: return nil
        }
    }
}
