import AppKit
import WebKit
import ApplicationServices
import CoreServices
import ImageIO

enum DockEdge: String { case left, right, top, bottom }

struct Docking {
    // The narrow strip returns to the desktop only when no actual window is under the pointer.
    static func isScreenDockGesture(at point: NSPoint, in screen: NSRect, hasWindowTarget: Bool = false) -> Bool {
        guard !hasWindowTarget else { return false }
        let distance = min(abs(point.x - screen.minX), abs(point.x - screen.maxX),
                           abs(point.y - screen.minY), abs(point.y - screen.maxY))
        return distance <= 8
    }

    static func origin(for frame: NSRect, in screen: NSRect) -> (NSPoint, DockEdge) {
        let center = NSPoint(x: frame.midX, y: frame.midY)
        let distances: [(CGFloat, DockEdge)] = [
            (abs(center.x - screen.minX), .left), (abs(center.x - screen.maxX), .right),
            (abs(center.y - screen.maxY), .top), (abs(center.y - screen.minY), .bottom)
        ]
        let edge = distances.min { $0.0 < $1.0 }!.1
        var point = NSPoint(x: min(max(frame.minX, screen.minX), screen.maxX - frame.width),
                            y: min(max(frame.minY, screen.minY), screen.maxY - frame.height))
        switch edge {
        case .left: point.x = screen.minX - frame.width * 0.30
        case .right: point.x = screen.maxX - frame.width * 0.70
        case .top: point.y = screen.maxY - frame.height * 0.70
        case .bottom: point.y = screen.minY - frame.height * 0.30
        }
        return (point, edge)
    }

    static func chatFrame(near pet: NSRect, screen: NSRect, size: NSSize) -> NSRect {
        let width = min(size.width, screen.width - 32)
        let height = min(size.height, screen.height - 48)
        let preferredX = pet.midX > screen.midX ? pet.minX - width - 10 : pet.maxX + 10
        return NSRect(x: min(max(preferredX, screen.minX + 16), screen.maxX - width - 16),
                      y: min(max(pet.midY - height * 0.55, screen.minY + 16), screen.maxY - height - 16),
                      width: width, height: height)
    }

    static func constrainedChatFrame(_ frame: NSRect, in screen: NSRect) -> NSRect {
        let area = screen.insetBy(dx: min(8, screen.width / 4), dy: min(8, screen.height / 4))
        let width = min(frame.width, area.width)
        let height = min(frame.height, area.height)
        return NSRect(x: min(max(frame.minX, area.minX), area.maxX - width),
                      y: min(max(frame.minY, area.minY), area.maxY - height),
                      width: width, height: height)
    }
}

enum WindowValue {
    static func integer(_ value: Any?) -> Int64? {
        guard let number = value as? NSNumber,
              CFGetTypeID(number) != CFBooleanGetTypeID(),
              number.doubleValue.isFinite else { return nil }
        let integer = number.int64Value
        return Double(integer) == number.doubleValue ? integer : nil
    }

    static func pid(_ value: Any?) -> pid_t? {
        guard let integer = integer(value), integer > 0, integer <= Int64(Int32.max) else { return nil }
        return pid_t(integer)
    }

    static func windowID(_ value: Any?) -> CGWindowID? {
        guard let integer = integer(value), integer > 0, integer <= Int64(UInt32.max) else { return nil }
        return CGWindowID(integer)
    }

    static func bounds(_ value: Any?) -> CGRect? {
        guard let dict = value as? [String: Any],
              let x = dict["X"] as? NSNumber, let y = dict["Y"] as? NSNumber,
              let width = dict["Width"] as? NSNumber, let height = dict["Height"] as? NSNumber,
              [x, y, width, height].allSatisfy({ $0.doubleValue.isFinite }),
              width.doubleValue > 0, height.doubleValue > 0 else { return nil }
        return CGRect(x: x.doubleValue, y: y.doubleValue, width: width.doubleValue, height: height.doubleValue)
    }

    static func appKitFrame(_ bounds: CGRect, primaryTop: CGFloat) -> NSRect {
        NSRect(x: bounds.minX, y: primaryTop - bounds.maxY, width: bounds.width, height: bounds.height)
    }
}

enum DialogOrigin {
    static func isTrusted(scheme: String, host: String, port: Int, base: URL) -> Bool {
        base.scheme == "http" && base.host == "127.0.0.1" && base.port != nil
            && scheme == base.scheme && host == base.host && port == base.port
    }
}

enum BrowserContextIdentity {
    static func matches(_ expected: AttachedWindow, current: AttachedWindow?) -> Bool {
        guard let current = current else { return false }
        return expected.token == current.token && expected.pid == current.pid && expected.bundleID == current.bundleID
    }

    static func webURL(_ raw: String) -> URL? {
        guard let url = URL(string: raw), ["http", "https"].contains(url.scheme?.lowercased() ?? ""),
              url.host != nil, url.user == nil, url.password == nil else { return nil }
        return url
    }

    static func pageKey(_ raw: String) -> String {
        guard var parts = URLComponents(string: raw) else { return raw }
        // Ordinary article anchors stay on the same source. Hash-router paths
        // identify different documents and must agree with the web/server keys.
        let fragment = parts.percentEncodedFragment ?? ""
        if !fragment.hasPrefix("/") && !fragment.hasPrefix("!") { parts.fragment = nil }
        return parts.string ?? raw
    }

    static func pageRevision(previousKey: String?, previousRevision: String, newKey: String) -> String {
        // The first URL only enriches an already-associated window. Later URL
        // changes remain detectable even after an unavailable read cleared url.
        guard let previousKey = previousKey, previousKey != newKey else { return previousRevision }
        return UUID().uuidString
    }

    static func boundsMatch(_ values: [Int], expected: CGRect) -> Bool {
        guard values.count == 4 else { return false }
        let target = [expected.minX, expected.minY, expected.maxX, expected.maxY].map { Int($0.rounded()) }
        return zip(values, target).allSatisfy { abs($0.0 - $0.1) < 12 }
    }
}

struct BrowserPageSnapshot {
    let url: String
    let title: String
    let browserWindowID: String
    let browserTabID: String
    var text: String = ""
    var selection: String = ""
    var textTruncated = false
    var contentSource: String = "metadata"
}

struct BrowserPageRevealTarget: Equatable {
    let browserWindowID: String
    let browserTabID: String
    let title: String
    let url: String

    init(snapshot: BrowserPageSnapshot) {
        browserWindowID = snapshot.browserWindowID
        browserTabID = snapshot.browserTabID
        title = snapshot.title
        url = BrowserContextIdentity.pageKey(snapshot.url)
    }
}

struct AttachmentPreviewTarget: Equatable {
    let attachmentID: String
    let pageRevision: String
    let pageKey: String
    let browserWindowID: String
    let browserTabID: String

    init?(_ context: [String: Any]) {
        guard let attachmentID = context["attachmentId"] as? String, let pageRevision = context["pageRevision"] as? String,
              let url = (context["url"] as? String).flatMap(BrowserContextIdentity.webURL),
              let window = context["browserWindowId"] as? String, let tab = context["browserTabId"] as? String else { return nil }
        self.attachmentID = attachmentID; self.pageRevision = pageRevision
        self.pageKey = BrowserContextIdentity.pageKey(url.absoluteString)
        self.browserWindowID = window; self.browserTabID = tab
    }

    func matches(_ snapshot: BrowserPageSnapshot) -> Bool {
        browserWindowID == snapshot.browserWindowID && browserTabID == snapshot.browserTabID
            && pageKey == BrowserContextIdentity.pageKey(snapshot.url)
    }
}

enum BrowserAttentionReader {
    static let quietOptions = NSAppleEventDescriptor.SendOptions(rawValue: UInt(kAEWaitReply | kAENeverInteract | kAEDoNotPromptForUserConsent))
    static let bundles: Set<String> = ["com.apple.Safari", "com.google.Chrome", "com.google.Chrome.canary",
                                      "com.microsoft.edgemac", "com.brave.Browser", "com.vivaldi.Vivaldi"]

    static func supports(_ bundleID: String?) -> Bool { bundles.contains(bundleID ?? "") }

    static func supportsPageReveal(_ bundleID: String?) -> Bool {
        bundleID == "com.google.Chrome" || bundleID == "com.google.Chrome.canary"
    }

    static func code(_ value: String) -> OSType { value.utf8.reduce(0) { ($0 << 8) | OSType($1) } }

    static func object(want: OSType, container: NSAppleEventDescriptor, form: OSType, selection: NSAppleEventDescriptor) throws -> NSAppleEventDescriptor {
        let record = NSAppleEventDescriptor.record()
        record.setDescriptor(NSAppleEventDescriptor(typeCode: want), forKeyword: AEKeyword(keyAEDesiredClass))
        record.setDescriptor(container, forKeyword: AEKeyword(keyAEContainer))
        record.setDescriptor(NSAppleEventDescriptor(enumCode: form), forKeyword: AEKeyword(keyAEKeyForm))
        record.setDescriptor(selection, forKeyword: AEKeyword(keyAEKeyData))
        guard let result = record.coerce(toDescriptorType: DescType(typeObjectSpecifier)) else { throw unavailable() }
        return result
    }

    static func property(_ name: OSType, of container: NSAppleEventDescriptor) throws -> NSAppleEventDescriptor {
        try object(want: OSType(cProperty), container: container, form: OSType(formPropertyID), selection: NSAppleEventDescriptor(typeCode: name))
    }

    static func unavailable() -> NSError { NSError(domain: "FORMEBrowserContext", code: 1, userInfo: nil) }

    private static func send(_ object: NSAppleEventDescriptor, value: NSAppleEventDescriptor? = nil,
                             target: NSAppleEventDescriptor, timeout: TimeInterval) throws -> NSAppleEventDescriptor {
        let eventID = value == nil ? kAEGetData : kAESetData
        let event = NSAppleEventDescriptor(eventClass: AEEventClass(kAECoreSuite), eventID: AEEventID(eventID),
                                          targetDescriptor: target, returnID: AEReturnID(kAutoGenerateReturnID), transactionID: AETransactionID(kAnyTransactionID))
        event.setParam(object, forKeyword: AEKeyword(keyDirectObject))
        if let value = value { event.setParam(value, forKeyword: AEKeyword(keyAEData)) }
        let reply = try event.sendEvent(options: quietOptions, timeout: timeout)
        if let number = reply.paramDescriptor(forKeyword: AEKeyword(keyErrorNumber))?.int32Value, number != 0 {
            throw NSError(domain: NSOSStatusErrorDomain, code: Int(number), userInfo: nil)
        }
        return reply
    }

    static func get(_ object: NSAppleEventDescriptor, target: NSAppleEventDescriptor, timeout: TimeInterval = 2) throws -> NSAppleEventDescriptor {
        let reply = try send(object, target: target, timeout: timeout)
        guard let value = reply.paramDescriptor(forKeyword: AEKeyword(keyDirectObject)) else { throw unavailable() }
        return value
    }

    static func rectangle(_ value: NSAppleEventDescriptor) -> [Int]? {
        if let values = value.coerce(toDescriptorType: DescType(typeAEList)), values.numberOfItems == 4 {
            let coordinates = (1...4).compactMap { values.atIndex($0).map { Int($0.int32Value) } }
            return coordinates.count == 4 ? coordinates : nil
        }
        if value.descriptorType == DescType(typeQDRectangle), value.data.count == 8 {
            let coordinates = value.data.withUnsafeBytes { bytes in
                (0..<4).map { Int(bytes.loadUnaligned(fromByteOffset: $0 * 2, as: Int16.self)) }
            }
            return [coordinates[1], coordinates[0], coordinates[3], coordinates[2]]
        }
        return nil
    }

    static func identity(_ value: NSAppleEventDescriptor) -> String {
        value.stringValue ?? value.coerce(toDescriptorType: DescType(typeUnicodeText))?.stringValue ?? ""
    }

    static func changed() -> NSError { NSError(domain: "FORMEBrowserContext", code: 2, userInfo: nil) }

    // This query seam exercises the exact native descriptor sequence without
    // sending events, changing permissions or substituting browser content.
    static func snapshot(_ window: AttachedWindow,
                         query: (NSAppleEventDescriptor) throws -> NSAppleEventDescriptor) throws -> BrowserPageSnapshot {
        let all = NSAppleEventDescriptor(typeCode: OSType(kAEAll))
        guard let ordinal = NSAppleEventDescriptor(descriptorType: DescType(typeAbsoluteOrdinal), data: all.data) else { throw unavailable() }
        let windows = try query(object(want: OSType(cWindow), container: .null(), form: OSType(formAbsolutePosition), selection: ordinal))
        guard windows.numberOfItems > 0, windows.numberOfItems <= 100 else { throw unavailable() }
        var matches: [NSAppleEventDescriptor] = []
        for index in 1...windows.numberOfItems {
            guard let candidate = windows.atIndex(index) else { continue }
            let bounds = try query(property(OSType(pBounds), of: candidate))
            if let values = rectangle(bounds), BrowserContextIdentity.boundsMatch(values, expected: window.cgBounds) { matches.append(candidate) }
        }
        guard matches.count == 1 else { throw unavailable() }
        let chosen = matches[0]
        let windowID = identity(try query(property(code("ID  "), of: chosen)))
        guard !windowID.isEmpty else { throw unavailable() }
        let safari = window.bundleID == "com.apple.Safari"
        let activeTabCode = code(safari ? "cTab" : "acTa")
        let tabIDCode = code(safari ? "pidx" : "ID  ")
        let urlCode = code(safari ? "pURL" : "URL ")
        let tab = try query(property(activeTabCode, of: chosen))
        let tabID = identity(try query(property(tabIDCode, of: tab)))
        let rawURL = try query(property(urlCode, of: tab)).stringValue ?? ""
        guard !tabID.isEmpty, let url = BrowserContextIdentity.webURL(rawURL) else { throw unavailable() }
        let title = try query(property(OSType(pName), of: tab)).stringValue ?? ""
        // Re-read the window and active tab after the title. A permission delay,
        // reordering windows or switching tabs must never produce a mixed tuple.
        let finalWindowID = identity(try query(property(code("ID  "), of: chosen)))
        let finalTab = try query(property(activeTabCode, of: chosen))
        let finalTabID = identity(try query(property(tabIDCode, of: finalTab)))
        let finalURL = try query(property(urlCode, of: finalTab)).stringValue ?? ""
        guard finalWindowID == windowID, finalTabID == tabID,
              BrowserContextIdentity.webURL(finalURL).map({ BrowserContextIdentity.pageKey($0.absoluteString) }) == BrowserContextIdentity.pageKey(url.absoluteString) else { throw changed() }
        return BrowserPageSnapshot(url: url.absoluteString, title: String(title.prefix(300)), browserWindowID: windowID, browserTabID: tabID)
    }

    static func read(_ window: AttachedWindow, requestPermission: Bool = false) throws -> BrowserPageSnapshot {
        let target = NSAppleEventDescriptor(processIdentifier: window.pid)
        // Apple documents that prompting can block for an arbitrary duration.
        // All callers run on captureQueue; passive reads never request consent.
        let permission = AEDeterminePermissionToAutomateTarget(target.aeDesc, AEEventClass(kAECoreSuite), AEEventID(kAEGetData), requestPermission)
        guard permission == noErr else { throw NSError(domain: NSOSStatusErrorDomain, code: Int(permission), userInfo: nil) }
        let deadline = ProcessInfo.processInfo.systemUptime + 5
        return try snapshot(window) { object in
            let remaining = deadline - ProcessInfo.processInfo.systemUptime
            guard remaining > 0 else { throw unavailable() }
            return try get(object, target: target, timeout: min(1, remaining))
        }
    }

    static func reveal(_ page: BrowserPageRevealTarget, in window: AttachedWindow, isCurrent: () -> Bool) throws -> Bool {
        guard supportsPageReveal(window.bundleID), isCurrent() else { throw unavailable() }
        let target = NSAppleEventDescriptor(processIdentifier: window.pid)
        let deadline = ProcessInfo.processInfo.systemUptime + 5
        func remainingTime() throws -> TimeInterval {
            let remaining = deadline - ProcessInfo.processInfo.systemUptime
            guard remaining > 0 else { throw unavailable() }
            return min(1, remaining)
        }
        let permission = AEDeterminePermissionToAutomateTarget(target.aeDesc, AEEventClass(kAECoreSuite), AEEventID(kAEGetData), false)
        guard permission == noErr else { throw NSError(domain: NSOSStatusErrorDomain, code: Int(permission), userInfo: nil) }
        return try reveal(page, in: window, isCurrent: isCurrent, query: { descriptor in
            try get(descriptor, target: target, timeout: remainingTime())
        }, write: { descriptor, value in
            let permission = AEDeterminePermissionToAutomateTarget(target.aeDesc, AEEventClass(kAECoreSuite), AEEventID(kAESetData), false)
            guard permission == noErr else { throw NSError(domain: NSOSStatusErrorDomain, code: Int(permission), userInfo: nil) }
            guard isCurrent() else { throw changed() }
            _ = try send(descriptor, value: value, target: target, timeout: remainingTime())
        })
    }

    static func reveal(_ page: BrowserPageRevealTarget, in window: AttachedWindow, isCurrent: () -> Bool,
                       query: (NSAppleEventDescriptor) throws -> NSAppleEventDescriptor,
                       write: (NSAppleEventDescriptor, NSAppleEventDescriptor) throws -> Void) throws -> Bool {
        guard supportsPageReveal(window.bundleID), !page.browserWindowID.isEmpty, !page.browserTabID.isEmpty,
              BrowserContextIdentity.webURL(page.url) != nil, isCurrent() else { throw unavailable() }
        let id = code("ID  ")
        let chosen = try object(want: OSType(cWindow), container: .null(), form: OSType(formUniqueID),
                                selection: NSAppleEventDescriptor(string: page.browserWindowID))
        let front = try object(want: OSType(cWindow), container: .null(), form: OSType(formAbsolutePosition),
                               selection: NSAppleEventDescriptor(int32: 1))
        func get(_ key: OSType, from specifier: NSAppleEventDescriptor) throws -> NSAppleEventDescriptor {
            try query(property(key, of: specifier))
        }
        func set(_ key: OSType, on specifier: NSAppleEventDescriptor, to value: NSAppleEventDescriptor) throws {
            guard isCurrent() else { throw changed() }
            try write(property(key, of: specifier), value)
        }
        guard try identity(get(id, from: chosen)) == page.browserWindowID,
              let bounds = try rectangle(get(OSType(pBounds), from: chosen)),
              BrowserContextIdentity.boundsMatch(bounds, expected: window.cgBounds) else { throw changed() }

        let minimized = code("pmnd")
        if try get(minimized, from: chosen).booleanValue {
            try set(minimized, on: chosen, to: NSAppleEventDescriptor(boolean: false))
            guard try !get(minimized, from: chosen).booleanValue else { throw unavailable() }
        }
        if try identity(get(id, from: front)) != page.browserWindowID {
            try set(OSType(pIndex), on: chosen, to: NSAppleEventDescriptor(int32: 1))
            guard try identity(get(id, from: front)) == page.browserWindowID else { throw unavailable() }
        }

        // Chrome identifies tabs by a stable ID, but sets the active tab by its
        // current one-based index. Revalidate the exact index before writing it.
        let tabClass = code("CrTb")
        func matchesTab(_ specifier: NSAppleEventDescriptor) throws -> Bool {
            guard try identity(get(id, from: specifier)) == page.browserTabID,
                  let rawURL = try get(code("URL "), from: specifier).stringValue,
                  let url = BrowserContextIdentity.webURL(rawURL) else { return false }
            return BrowserContextIdentity.pageKey(url.absoluteString) == page.url
        }
        func restoreTab() throws -> Bool {
            let active = try get(code("acTa"), from: chosen)
            if try matchesTab(active) { return true }
            let all = NSAppleEventDescriptor(enumCode: OSType(kAEAll))
            guard let ordinal = NSAppleEventDescriptor(descriptorType: DescType(typeAbsoluteOrdinal), data: all.data) else { return false }
            let tabs = try query(object(want: tabClass, container: chosen, form: OSType(formAbsolutePosition), selection: ordinal))
            guard tabs.numberOfItems > 0 else { return false }
            for index in 1...tabs.numberOfItems {
                guard let tab = tabs.atIndex(index), try matchesTab(tab) else { continue }
                let candidate = try object(want: tabClass, container: chosen, form: OSType(formAbsolutePosition),
                                           selection: NSAppleEventDescriptor(int32: Int32(index)))
                guard try matchesTab(candidate) else { return false }
                try set(code("acTI"), on: chosen, to: NSAppleEventDescriptor(int32: Int32(index)))
                return try matchesTab(get(code("acTa"), from: chosen))
            }
            return false
        }
        let restored = (try? restoreTab()) == true
        guard isCurrent() else { throw changed() }
        return restored
    }

}

struct BrowserPageText {
    let text: String
    let selection: String
    let truncated: Bool
}

struct BrowserAXTraits {
    let role: String
    let subrole: String
    let editable: Bool
}

enum BrowserAXBodyPolicy {
    static let excludedRoles: Set<String> = ["AXTextField", "AXTextArea", "AXComboBox", "AXSearchField", "AXSecureTextField",
        "AXToolbar", "AXMenuBar", "AXMenu", "AXDialog", "AXSheet"]
    static let excludedLandmarks: Set<String> = ["AXLandmarkNavigation", "AXLandmarkBanner", "AXLandmarkContentInfo",
        "AXLandmarkComplementary", "AXLandmarkSearch", "AXLandmarkForm", "AXApplicationDialog", "AXApplicationAlertDialog"]

    static func skips(_ traits: BrowserAXTraits) -> Bool {
        traits.editable || traits.role.isEmpty || excludedRoles.contains(traits.role)
            || excludedLandmarks.contains(traits.subrole) || excludedLandmarks.contains(traits.role)
    }

    // Browser web landmarks are usually AXGroup subroles, not independent AppKit roles.
    static func preferredRoot<Element>(area: Element, traits: (Element) -> BrowserAXTraits,
                                       children: (Element) -> [Element], visit: () -> Bool) -> Element {
        var queue = [area], index = 0, mains: [Element] = [], articles: [Element] = []
        while index < queue.count && index < 256 && visit() {
            let element = queue[index]; index += 1
            let descriptor = traits(element)
            guard !skips(descriptor), descriptor.role != "AXWebArea" || index == 1 else { continue }
            if descriptor.subrole == "AXLandmarkMain" || descriptor.role == "AXLandmarkMain" {
                mains.append(element); continue
            }
            if descriptor.subrole == "AXDocumentArticle" || descriptor.role == "AXArticle" || descriptor.role == "AXDocumentArticle" {
                articles.append(element); continue
            }
            if descriptor.role != "AXStaticText" { queue.append(contentsOf: children(element)) }
        }
        guard index == queue.count else { return area }
        if mains.count == 1 { return mains[0] }
        if mains.isEmpty && articles.count == 1 { return articles[0] }
        return area
    }
}

enum BrowserAccessibilityReader {
    static let excludedRoles = BrowserAXBodyPolicy.excludedRoles

    static func attribute(_ element: AXUIElement, _ name: String) -> CFTypeRef? {
        AXUIElementSetMessagingTimeout(element, 0.12)
        var value: CFTypeRef?
        return AXUIElementCopyAttributeValue(element, name as CFString, &value) == .success ? value : nil
    }

    static func traits(_ element: AXUIElement) -> BrowserAXTraits {
        AXUIElementSetMessagingTimeout(element, 0.12)
        var values: CFArray?
        let names = [kAXRoleAttribute, kAXSubroleAttribute, kAXIsEditableAttribute as String] as CFArray
        let result = AXUIElementCopyMultipleAttributeValues(element, names, AXCopyMultipleAttributeOptions(rawValue: 0), &values)
        guard result == .success, let fields = values as? [Any], fields.count == 3 else {
            return BrowserAXTraits(role: "", subrole: "", editable: true)
        }
        return BrowserAXTraits(role: fields[0] as? String ?? "", subrole: fields[1] as? String ?? "",
                               editable: (fields[2] as? Bool) == true)
    }

    static func children(_ element: AXUIElement) -> [AXUIElement] {
        attribute(element, kAXChildrenAttribute) as? [AXUIElement] ?? []
    }

    static func frame(_ element: AXUIElement) -> CGRect? {
        guard let position = attribute(element, kAXPositionAttribute), CFGetTypeID(position) == AXValueGetTypeID(),
              let size = attribute(element, kAXSizeAttribute), CFGetTypeID(size) == AXValueGetTypeID() else { return nil }
        var point = CGPoint.zero, dimensions = CGSize.zero
        guard AXValueGetValue(position as! AXValue, .cgPoint, &point), AXValueGetValue(size as! AXValue, .cgSize, &dimensions) else { return nil }
        return CGRect(origin: point, size: dimensions)
    }

    static func reportedAddress(_ element: AXUIElement, attributeName: String) -> String? {
        let value = attribute(element, attributeName)
        let raw = (value as? URL)?.absoluteString ?? value as? String
        let address = raw?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        return address.isEmpty ? nil : address
    }

    static func pageURL(_ element: AXUIElement) -> String? {
        reportedAddress(element, attributeName: kAXURLAttribute).flatMap(BrowserContextIdentity.webURL)?.absoluteString
    }

    // Query only the user-associated window and its matching web area. In
    // particular, never extract address bars, password fields or editable input.
    static func read(_ selected: AttachedWindow, expectedURL: String, includeSelection: Bool = true) -> BrowserPageText? {
        guard AXIsProcessTrusted() else { return nil }
        let deadline = ProcessInfo.processInfo.systemUptime + 2.0
        let application = AXUIElementCreateApplication(selected.pid)
        guard let windows = attribute(application, kAXWindowsAttribute) as? [AXUIElement] else { return nil }
        let matches = windows.filter { element in
            guard ProcessInfo.processInfo.systemUptime < deadline, let rect = frame(element) else { return false }
            return abs(rect.minX - selected.cgBounds.minX) < 12 && abs(rect.minY - selected.cgBounds.minY) < 12
                && abs(rect.width - selected.cgBounds.width) < 12 && abs(rect.height - selected.cgBounds.height) < 12
        }
        guard matches.count == 1 else { return nil }
        let expectedKey = BrowserContextIdentity.pageKey(expectedURL)
        var queue: [AXUIElement] = [matches[0]], areas: [AXUIElement] = [], visited = 0
        while !queue.isEmpty, visited < 300, ProcessInfo.processInfo.systemUptime < deadline {
            let element = queue.removeFirst(); visited += 1
            let role = attribute(element, kAXRoleAttribute) as? String ?? ""
            if role == "AXWebArea" {
                if pageURL(element).map(BrowserContextIdentity.pageKey) == expectedKey { areas.append(element) }
                continue
            }
            if !excludedRoles.contains(role) { queue.append(contentsOf: children(element)) }
        }
        guard areas.count == 1, let content = readBody(in: areas[0], deadline: deadline, includeSelection: includeSelection),
              pageURL(areas[0]).map(BrowserContextIdentity.pageKey) == expectedKey else { return nil }
        return content
    }

    // The caller must verify the identity of the web area before reading it.
    static func readBody(in area: AXUIElement, deadline: TimeInterval, includeSelection: Bool = true) -> BrowserPageText? {
        var scanned = 0
        func visit() -> Bool {
            guard scanned < 1800, ProcessInfo.processInfo.systemUptime < deadline else { return false }
            scanned += 1; return true
        }
        let root = BrowserAXBodyPolicy.preferredRoot(area: area, traits: traits, children: children, visit: visit)
        var fragments: [String] = [], count = 0, selection = ""
        var queue = [root]
        while !queue.isEmpty, count < 40000, visit() {
            let element = queue.removeLast()
            let descriptor = traits(element)
            guard !BrowserAXBodyPolicy.skips(descriptor), descriptor.role != "AXWebArea" || CFEqual(element, area) else { continue }
            if descriptor.role == "AXStaticText", let value = attribute(element, kAXValueAttribute) as? String {
                // Selection is read only from safe body text nodes, never from an ancestor that could
                // proxy a focused search/input/form descendant's current selection.
                if includeSelection, selection.isEmpty, let selectedText = attribute(element, kAXSelectedTextAttribute) as? String {
                    selection = String(selectedText.trimmingCharacters(in: .whitespacesAndNewlines).prefix(12000))
                }
                let fragment = value.trimmingCharacters(in: .whitespacesAndNewlines)
                if !fragment.isEmpty, fragments.last != fragment {
                    let bounded = String(fragment.prefix(max(40000 - count, 0)))
                    fragments.append(bounded); count += bounded.count + 1
                }
            }
            if descriptor.role != "AXStaticText" { queue.append(contentsOf: children(element).reversed()) }
        }
        let text = String(fragments.joined(separator: "\n").prefix(40000))
        guard text.count >= 20 || !selection.isEmpty else { return nil }
        return BrowserPageText(text: text, selection: selection, truncated: !queue.isEmpty || count >= 40000)
    }
}

enum WeChatArticleAccessibility {
    static let permissionError = NSError(domain: "FolioWeChatAccessibility", code: 1, userInfo: nil)

    static func supports(_ bundleID: String?) -> Bool {
        bundleID == "com.tencent.xinWeChat" || bundleID == "com.tencent.flue.WeChatAppEx"
    }

    static func articleURL(_ raw: String) -> String? {
        guard let url = BrowserContextIdentity.webURL(raw), url.host?.lowercased() == "mp.weixin.qq.com",
              url.port == nil || (url.scheme?.lowercased() == "http" ? url.port == 80 : url.port == 443),
              var parts = URLComponents(url: url, resolvingAgainstBaseURL: false) else { return nil }
        parts.scheme = "https"; parts.host = "mp.weixin.qq.com"; parts.port = nil; parts.fragment = nil
        if parts.percentEncodedPath.range(of: "^/s/[A-Za-z0-9_-]{1,160}/?$", options: .regularExpression) != nil {
            if parts.path.hasSuffix("/") { parts.path.removeLast() }
            parts.query = nil
            return parts.string
        }
        guard ["/s", "/s/"].contains(parts.percentEncodedPath) else { return nil }
        let identifiers = [("__biz", "^[A-Za-z0-9_+/=-]{1,160}$"), ("mid", "^[0-9]{1,20}$"),
                           ("idx", "^[0-9]{1,20}$"), ("sn", "^[A-Za-z0-9_-]{1,128}$")]
        let query = parts.queryItems ?? []
        var articleQuery: [URLQueryItem] = []
        for (name, pattern) in identifiers {
            let items = query.filter { $0.name == name }
            guard items.count == 1, let value = items[0].value,
                  value.range(of: pattern, options: .regularExpression) != nil else { return nil }
            articleQuery.append(items[0])
        }
        parts.path = "/s"; parts.queryItems = articleQuery
        return parts.string
    }

    private static func window(for selected: AttachedWindow, deadline: TimeInterval) -> AXUIElement? {
        func matches(_ element: AXUIElement) -> Bool {
            var pid: pid_t = 0
            guard AXUIElementGetPid(element, &pid) == .success, pid == selected.pid,
                  let frame = BrowserAccessibilityReader.frame(element),
                  [frame.minX, frame.minY, frame.maxX, frame.maxY].allSatisfy(\.isFinite) else { return false }
            return BrowserContextIdentity.boundsMatch([frame.minX, frame.minY, frame.maxX, frame.maxY].map { Int($0.rounded()) }, expected: selected.cgBounds)
        }
        if let element = selected.axElement, matches(element) { return element }
        let application = AXUIElementCreateApplication(selected.pid)
        let windows = BrowserAccessibilityReader.attribute(application, kAXWindowsAttribute) as? [AXUIElement] ?? []
        var candidates: [AXUIElement] = []
        func add(_ element: AXUIElement) {
            if !candidates.contains(where: { CFEqual($0, element) }), matches(element) { candidates.append(element) }
        }
        for element in windows {
            guard ProcessInfo.processInfo.systemUptime < deadline else { return nil }
            add(element)
        }
        if candidates.isEmpty {
            for name in [kAXFocusedWindowAttribute, kAXMainWindowAttribute] {
                guard ProcessInfo.processInfo.systemUptime < deadline else { return nil }
                if let value = BrowserAccessibilityReader.attribute(application, name), CFGetTypeID(value) == AXUIElementGetTypeID() {
                    add(value as! AXUIElement)
                }
            }
        }
        return candidates.count == 1 ? candidates[0] : nil
    }

    static func articleCandidate(areaAddresses: [[String]], windowAddresses: () -> [String]) -> (index: Int, url: String)? {
        func consistentArticle(_ addresses: [String]) -> String? {
            guard let first = addresses.first, let url = articleURL(first),
                  addresses.allSatisfy({ articleURL($0) == url }) else { return nil }
            return url
        }
        var found: (index: Int, url: String)?
        for (index, addresses) in areaAddresses.enumerated() {
            guard addresses.contains(where: { articleURL($0) != nil }) else { continue }
            guard found == nil, let url = consistentArticle(addresses) else { return nil }
            found = (index, url)
        }
        if let found = found { return found }
        guard areaAddresses.count == 1, areaAddresses[0].isEmpty,
              let url = consistentArticle(windowAddresses()) else { return nil }
        return (0, url)
    }

    static func hasUnambiguousVisibleArea(_ frame: CGRect?, in window: CGRect, competingFrames: [CGRect?]) -> Bool {
        guard let frame = frame, [frame.minX, frame.minY, frame.width, frame.height].allSatisfy(\.isFinite),
              [window.minX, window.minY, window.width, window.height].allSatisfy(\.isFinite),
              frame.width > 0, frame.height > 0 else { return false }
        let visible = frame.intersection(window)
        let area = visible.width * visible.height
        guard !visible.isEmpty, area >= frame.width * frame.height * 0.5 else { return false }
        for other in competingFrames {
            guard let other = other, [other.minX, other.minY, other.width, other.height].allSatisfy(\.isFinite) else { return false }
            let overlap = visible.intersection(other)
            if !overlap.isEmpty, overlap.width * overlap.height >= area * 0.25 { return false }
        }
        return true
    }

    private static func article(in window: AXUIElement, deadline: TimeInterval) -> (area: AXUIElement, url: String)? {
        func reportedAddresses(_ element: AXUIElement) -> [String] {
            [kAXURLAttribute, kAXDocumentAttribute].compactMap { BrowserAccessibilityReader.reportedAddress(element, attributeName: $0) }
        }
        var queue = [window], index = 0, areas: [AXUIElement] = []
        while index < queue.count, index < 300, ProcessInfo.processInfo.systemUptime < deadline {
            let element = queue[index]; index += 1
            let role = BrowserAccessibilityReader.attribute(element, kAXRoleAttribute) as? String ?? ""
            if role == "AXWebArea" { areas.append(element); continue }
            if !role.isEmpty, role != "AXStaticText", !BrowserAccessibilityReader.excludedRoles.contains(role) {
                queue.append(contentsOf: BrowserAccessibilityReader.children(element))
            }
        }
        guard index == queue.count else { return nil }
        let multiple = areas.count > 1
        var possible: [AXUIElement] = []
        var addresses: [[String]] = []
        for area in areas {
            guard ProcessInfo.processInfo.systemUptime < deadline else { return nil }
            if multiple, (BrowserAccessibilityReader.attribute(area, "AXHidden") as? NSNumber)?.boolValue == true { continue }
            possible.append(area)
            addresses.append(reportedAddresses(area))
        }
        guard ProcessInfo.processInfo.systemUptime < deadline,
              let candidate = articleCandidate(areaAddresses: addresses, windowAddresses: { multiple ? [] : reportedAddresses(window) }) else { return nil }
        let area = possible[candidate.index]
        if multiple {
            guard let windowFrame = BrowserAccessibilityReader.frame(window) else { return nil }
            var frames: [CGRect?] = []
            for (index, competing) in possible.enumerated() where index != candidate.index {
                guard ProcessInfo.processInfo.systemUptime < deadline else { return nil }
                frames.append(BrowserAccessibilityReader.frame(competing))
            }
            guard ProcessInfo.processInfo.systemUptime < deadline,
                  hasUnambiguousVisibleArea(BrowserAccessibilityReader.frame(area), in: windowFrame, competingFrames: frames) else { return nil }
        }
        return (area, candidate.url)
    }

    private static func title(_ candidates: [String]) -> String? {
        let generic: Set<String> = ["微信", "wechat", "微信 (窗口)", "微信（窗口）", "公众号", "微信公众平台"]
        for candidate in candidates {
            let title = candidate.trimmingCharacters(in: .whitespacesAndNewlines)
            if !title.isEmpty, !generic.contains(title.lowercased()), BrowserContextIdentity.webURL(title) == nil {
                return String(title.prefix(300))
            }
        }
        return nil
    }

    private static func headingTitle(in verifiedArea: AXUIElement, deadline: TimeInterval) -> String? {
        typealias Reader = BrowserAccessibilityReader
        var queue = [(verifiedArea, 0)], index = 0, headings: [AXUIElement] = []
        while index < queue.count, index < 64, ProcessInfo.processInfo.systemUptime < deadline {
            let (element, depth) = queue[index]; index += 1
            let traits = Reader.traits(element)
            guard !BrowserAXBodyPolicy.skips(traits), depth == 0 || traits.role != "AXWebArea" else { continue }
            if traits.role == "AXHeading" {
                let level = Reader.attribute(element, "AXHeadingLevel") as? NSNumber ?? Reader.attribute(element, "AXLevel") as? NSNumber
                if level?.intValue == 1 { headings.append(element) }
            } else if depth < 5, traits.role != "AXStaticText" {
                queue.append(contentsOf: Reader.children(element).prefix(64).map { ($0, depth + 1) })
            }
        }
        guard index == queue.count, headings.count == 1 else { return nil }
        let heading = headings[0]
        if let value = title([kAXTitleAttribute, kAXValueAttribute].compactMap({ Reader.attribute(heading, $0) as? String })) { return value }
        let children = Reader.children(heading)
        guard children.count == 1, let child = children.first else { return nil }
        let traits = Reader.traits(child)
        guard traits.role == "AXStaticText", !BrowserAXBodyPolicy.skips(traits) else { return nil }
        return title([Reader.attribute(child, kAXValueAttribute) as? String ?? ""])
    }

    static func read(_ selected: AttachedWindow, includeBody: Bool, expectedURL: String? = nil) throws -> BrowserPageSnapshot {
        let deadline = ProcessInfo.processInfo.systemUptime + 2.5
        guard supports(selected.bundleID) else { throw BrowserAttentionReader.unavailable() }
        guard AXIsProcessTrusted() else { throw permissionError }
        guard let window = Self.window(for: selected, deadline: deadline),
              let identified = article(in: window, deadline: deadline) else { throw BrowserAttentionReader.unavailable() }
        if let expectedURL = expectedURL, identified.url != expectedURL { throw BrowserAttentionReader.changed() }
        let titles = [identified.area, window].compactMap { BrowserAccessibilityReader.attribute($0, kAXTitleAttribute) as? String }
        guard let title = Self.title(titles + [selected.title]) ?? headingTitle(in: identified.area, deadline: deadline) else {
            throw BrowserAttentionReader.unavailable()
        }
        var snapshot = BrowserPageSnapshot(url: identified.url, title: title, browserWindowID: selected.token.uuidString, browserTabID: "")
        guard includeBody else { return snapshot }
        let content = BrowserAccessibilityReader.readBody(in: identified.area, deadline: deadline, includeSelection: false)
        let verificationDeadline = ProcessInfo.processInfo.systemUptime + 1.0
        guard let current = article(in: window, deadline: verificationDeadline), current.url == identified.url,
              CFEqual(current.area, identified.area) else { throw BrowserAttentionReader.changed() }
        if let content = content {
            let lines = content.text.split(separator: "\n").filter { String($0) != title }
            if lines.joined().count >= 20 {
                snapshot.text = content.text
                snapshot.textTruncated = content.truncated
                snapshot.contentSource = "browser-accessibility"
            }
        }
        return snapshot
    }
}

struct AttachedWindow {
    let token: UUID
    let id: CGWindowID
    let pid: pid_t
    let appName: String
    let bundleID: String?
    let title: String
    let axElement: AXUIElement?
    var cgBounds: CGRect
    init(id: CGWindowID, pid: pid_t, appName: String, bundleID: String?, title: String,
         cgBounds: CGRect, axElement: AXUIElement? = nil, token: UUID = UUID()) {
        self.token = token; self.id = id; self.pid = pid; self.appName = appName
        self.bundleID = bundleID; self.title = title; self.cgBounds = cgBounds; self.axElement = axElement
    }
    var frame: NSRect {
        let top = NSScreen.screens.first?.frame.maxY ?? cgBounds.maxY
        return WindowValue.appKitFrame(cgBounds, primaryTop: top)
    }
}

enum AttachmentMenuLabel {
    static func title(for window: AttachedWindow?, context: [String: Any]) -> String {
        guard let window = window else { return "当前吸附 · 屏幕边缘" }
        let current = context["attachmentId"] as? String == window.token.uuidString
        let url = current ? (context["url"] as? String).flatMap(BrowserContextIdentity.webURL) : nil
        if WeChatArticleAccessibility.supports(window.bundleID),
           !(current && context["sourceType"] as? String == "wechat-article") {
            return "当前吸附 · 微信窗口"
        }
        let host = url?.host?.lowercased() ?? ""
        func matches(_ domain: String) -> Bool { host == domain || host.hasSuffix("." + domain) }
        let source: String
        if host == "mp.weixin.qq.com" { source = "公众号" }
        else if matches("youtube.com") || host == "youtu.be" { source = "YouTube" }
        else if matches("xiaohongshu.com") || matches("xhslink.com") || matches("rednote.com") { source = "小红书" }
        else { source = host.isEmpty ? window.appName : host }
        let title = current ? context["title"] as? String ?? window.title : window.title
        func display(_ text: String, limit: Int) -> String {
            let line = text.split(whereSeparator: \.isWhitespace).joined(separator: " ")
            return line.count <= limit ? line : String(line.prefix(limit - 1)) + "…"
        }
        let items = ["当前吸附", display(source, limit: 30), display(title, limit: 48)]
        return items.filter { !$0.isEmpty }.joined(separator: " · ")
    }
}

enum WindowProbe {
    static func visible() -> [AttachedWindow] {
        let rows = CGWindowListCopyWindowInfo([.optionOnScreenOnly, .excludeDesktopElements], kCGNullWindowID) as? [[String: Any]] ?? []
        return rows.compactMap { row in
            guard let pid = WindowValue.pid(row[kCGWindowOwnerPID as String]), pid != getpid(),
                  WindowValue.integer(row[kCGWindowLayer as String]) == 0,
                  let id = WindowValue.windowID(row[kCGWindowNumber as String]),
                  let bounds = WindowValue.bounds(row[kCGWindowBounds as String]),
                  bounds.width > 200, bounds.height > 120 else { return nil }
            let app = NSRunningApplication(processIdentifier: pid)
            return AttachedWindow(id: id, pid: pid,
                appName: row[kCGWindowOwnerName as String] as? String ?? app?.localizedName ?? "应用",
                bundleID: app?.bundleIdentifier, title: row[kCGWindowName as String] as? String ?? "", cgBounds: bounds)
        }
    }

    static func metadata(for id: CGWindowID) -> [PetWindowMetadata]? {
        guard id != 0 else { return nil }
        var encodedID = UnsafeRawPointer(bitPattern: UInt(id))
        guard let ids = CFArrayCreate(kCFAllocatorDefault, &encodedID, 1, nil),
              let rows = CGWindowListCreateDescriptionFromArray(ids) as? [[String: Any]] else { return nil }
        return PetWindowMetadata.parse(rows)
    }

    static func matchingMetadata(for target: AttachedWindow, in rows: [PetWindowMetadata]?) -> PetWindowMetadata? {
        rows?.first { $0.id == target.id && $0.pid == target.pid }
    }

    static func target(at point: NSPoint, windows: [AttachedWindow], primaryTop: CGFloat) -> AttachedWindow? {
        // Preserve WindowServer's front-to-back order for overlapping windows.
        windows.first { WindowValue.appKitFrame($0.cgBounds, primaryTop: primaryTop).contains(point) }
    }
}

struct PetWindowMetadata {
    let id: CGWindowID
    let pid: pid_t
    let bounds: CGRect
    let layer: Int
    let onScreen: Bool?
    let alpha: CGFloat
    var ownerName: String? = nil

    static func parse(_ rows: [[String: Any]], assumeOnScreen: Bool = false) -> [PetWindowMetadata] {
        rows.compactMap { row in
            guard let id = WindowValue.windowID(row[kCGWindowNumber as String]),
                  let pid = WindowValue.pid(row[kCGWindowOwnerPID as String]),
                  let bounds = WindowValue.bounds(row[kCGWindowBounds as String]) else { return nil }
            return PetWindowMetadata(id: id, pid: pid, bounds: bounds,
                layer: Int(WindowValue.integer(row[kCGWindowLayer as String]) ?? 0),
                onScreen: (row[kCGWindowIsOnscreen as String] as? NSNumber)?.boolValue ?? (assumeOnScreen ? true : nil),
                alpha: (row[kCGWindowAlpha as String] as? NSNumber).map { CGFloat($0.doubleValue) } ?? 1,
                ownerName: row[kCGWindowOwnerName as String] as? String)
        }
    }
}

struct PetWindowScene {
    let recordedAt: TimeInterval
    let all: [PetWindowMetadata]?
    let frontToBack: [PetWindowMetadata]?

    static func capture(at time: TimeInterval) -> PetWindowScene {
        let all = CGWindowListCopyWindowInfo([.optionAll, .excludeDesktopElements], kCGNullWindowID) as? [[String: Any]]
        let front = CGWindowListCopyWindowInfo([.optionOnScreenOnly, .excludeDesktopElements], kCGNullWindowID) as? [[String: Any]]
        return PetWindowScene(recordedAt: time, all: all.map { PetWindowMetadata.parse($0) }, frontToBack: front.map { PetWindowMetadata.parse($0, assumeOnScreen: true) })
    }
}

enum PetWindowAvailability: Equatable { case visible, suspended, closed }

struct PetWindowFollowResult {
    let target: AttachedWindow
    let availability: PetWindowAvailability
    let scene: PetWindowScene
}

enum PetAttachmentVisibility {
    static func canFit(_ frame: NSRect, edge: DockEdge, in screen: NSRect? = nil) -> Bool {
        let body = CompanionResource.layout.bodyBounds.rect
        let width = body.width * PetMotion.labelScale, height = body.height * PetMotion.labelScale
        switch edge {
        case .top:
            let range = screen.map { PetDockGeometry.topContactRange(frame, in: $0) }
            return frame.width >= 132 && frame.height >= height + 2 && (range.map { $0.low <= $0.high } ?? true)
        case .bottom: return frame.width >= width + 2 * PetFilletMaterial.outwardReach + 4 && frame.height >= height + 2
        case .left, .right: return frame.height >= height + 2 * PetFilletMaterial.outwardReach + 4 && frame.width >= width + 2
        }
    }

    static func isCovered(body: NSRect, contact: PetContact, target: AttachedWindow,
                          windows: [PetWindowMetadata], primaryTop: CGFloat, ownPID: pid_t,
                          fillets: [PetContour] = [], artworkFrame: NSRect = .zero,
                          maximumLayer: Int = Int(CGWindowLevelForKey(.floatingWindow)),
                          onCovered: ((PetWindowMetadata?, NSPoint?) -> Void)? = nil) -> Bool {
        let targetFrame = WindowValue.appKitFrame(target.cgBounds, primaryTop: primaryTop)
        // Probe opaque interior, not the transparent canvas/padding or the intentional .12pt contact overlap.
        let region = body.insetBy(dx: 2, dy: 2).intersection(targetFrame.insetBy(dx: 0.5, dy: 0.5))
        guard !region.isEmpty else { onCovered?(nil, nil); return true }
        let matching = windows.indices.filter { index in
            let row = windows[index]
            guard row.pid == target.pid else { return false }
            if target.id != 0 { return row.id == target.id }
            return abs(row.bounds.minX - target.cgBounds.minX) < 3 && abs(row.bounds.minY - target.cgBounds.minY) < 3
                && abs(row.bounds.width - target.cgBounds.width) < 3 && abs(row.bounds.height - target.cgBounds.height) < 3
        }
        let stop = matching.count == 1 ? matching[0] : windows.count
        var probes: [NSPoint] = []
        for x: CGFloat in [0.18, 0.5, 0.82] {
            for y: CGFloat in [0.18, 0.5, 0.82] {
                probes.append(NSPoint(x: region.minX + region.width * x, y: region.minY + region.height * y))
            }
        }
        let seam = NSPoint(x: contact.point.x + contact.normal.dx * 1.5,
                           y: contact.point.y + contact.normal.dy * 1.5)
        if targetFrame.contains(seam) { probes.append(seam) }
        for fillet in fillets {
            guard let outer = fillet.curves.first else { continue }
            let path = NSBezierPath(); path.move(to: fillet.start)
            for curve in fillet.curves { path.curve(to: curve.end, controlPoint1: curve.first, controlPoint2: curve.second) }
            path.close()
            for t: CGFloat in [0.25, 0.45, 0.70] {
                let u = 1 - t
                let edge = NSPoint(x: u * u * u * fillet.start.x + 3 * u * u * t * outer.first.x + 3 * u * t * t * outer.second.x + t * t * t * outer.end.x,
                                   y: u * u * u * fillet.start.y + 3 * u * u * t * outer.first.y + 3 * u * t * t * outer.second.y + t * t * t * outer.end.y)
                let candidates = [NSPoint(x: edge.x + 0.25, y: edge.y), NSPoint(x: edge.x - 0.25, y: edge.y),
                                  NSPoint(x: edge.x, y: edge.y + 0.25), NSPoint(x: edge.x, y: edge.y - 0.25)]
                if let inside = candidates.first(where: { point in
                    let world = NSPoint(x: point.x + artworkFrame.minX, y: point.y + artworkFrame.minY)
                    return path.contains(point) && targetFrame.insetBy(dx: 0.5, dy: 0.5).contains(world)
                }) {
                    probes.append(NSPoint(x: inside.x + artworkFrame.minX, y: inside.y + artworkFrame.minY))
                }
            }
        }
        for row in windows.prefix(stop) {
            // Only correct windows our floating surface could wrongly cover. Higher layers
            // already cover us in WindowServer and may have mostly transparent system surfaces.
            guard row.pid != ownPID, row.onScreen == true, row.layer >= 0, row.layer <= maximumLayer, row.alpha > 0.05,
                  !(row.id == target.id && row.pid == target.pid) else { continue }
            let bounds = WindowValue.appKitFrame(row.bounds, primaryTop: primaryTop)
            if let point = probes.first(where: { bounds.contains($0) }) {
                onCovered?(row, point); return true
            }
        }
        return false
    }
}

// A separate, small event window is always receptive inside the real artwork hit region.
// The 72x84 rendering window remains click-through, so incoming mouseDown never races a monitor.
final class PetInputPanel: NSPanel {
    static func make(region: NSRect, target: PetView) -> PetInputPanel {
        let panel = PetInputPanel(contentRect: region, styleMask: [.borderless, .nonactivatingPanel], backing: .buffered, defer: false)
        panel.isReleasedWhenClosed = false; panel.isOpaque = false; panel.backgroundColor = NSColor.white.withAlphaComponent(1 / 255)
        panel.hasShadow = false; panel.hidesOnDeactivate = false; panel.ignoresMouseEvents = false
        panel.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary]
        panel.setAccessibilityElement(false); panel.setAccessibilityHidden(true)
        let proxy = PetInputView(frame: NSRect(origin: .zero, size: region.size)); proxy.target = target
        proxy.setAccessibilityElement(false); proxy.setAccessibilityHidden(true)
        proxy.autoresizingMask = [.width, .height]; panel.contentView = proxy
        return panel
    }
    override var canBecomeKey: Bool { false }
    override var canBecomeMain: Bool { false }
    override func constrainFrameRect(_ frameRect: NSRect, to screen: NSScreen?) -> NSRect { frameRect }
}

final class PetInputView: NSView {
    weak var target: PetView?
    private var tracking: NSTrackingArea?
    override var isOpaque: Bool { false }
    override func acceptsFirstMouse(for event: NSEvent?) -> Bool { true }
    override func updateTrackingAreas() {
        super.updateTrackingAreas()
        if let tracking = tracking { removeTrackingArea(tracking) }
        let area = NSTrackingArea(rect: bounds, options: [.activeAlways, .mouseEnteredAndExited, .mouseMoved, .inVisibleRect], owner: self)
        addTrackingArea(area); tracking = area
    }
    override func resetCursorRects() { addCursorRect(bounds, cursor: target?.dragging == true ? .closedHand : .openHand) }
    override func mouseEntered(with event: NSEvent) { target?.mouseEntered(with: event) }
    override func mouseExited(with event: NSEvent) { target?.mouseExited(with: event) }
    override func mouseMoved(with event: NSEvent) { target?.mouseMoved(with: event) }
    override func mouseDown(with event: NSEvent) { target?.mouseDown(with: event) }
    override func mouseDragged(with event: NSEvent) { target?.mouseDragged(with: event) }
    override func mouseUp(with event: NSEvent) { target?.mouseUp(with: event) }
    override func rightMouseDown(with event: NSEvent) {
        // Keep the context-menu event and its anchor view in the same small window coordinates.
        target?.owner?.showPetMenu(event: event, view: self)
    }
}

final class CandidateOutlineView: NSView {
    override var isOpaque: Bool { false }
    override func draw(_ dirtyRect: NSRect) {
        NSColor.clear.setFill(); bounds.fill()
        let outline = NSBezierPath(roundedRect: bounds.insetBy(dx: 2, dy: 2), xRadius: 12, yRadius: 12)
        NSColor.white.withAlphaComponent(0.65).setStroke()
        outline.lineWidth = 1; outline.stroke()
    }
}

final class PetPanel: NSPanel {
    var allowsPresentation = true
    override var canBecomeKey: Bool { false }
    override var canBecomeMain: Bool { false }
    override func constrainFrameRect(_ frameRect: NSRect, to screen: NSScreen?) -> NSRect {
        // This is a transparent motion canvas. Dock geometry positions its visible artwork;
        // constraining the canvas itself would clip top attachments and shift completed morphs.
        frameRect
    }
    override func setFrame(_ frameRect: NSRect, display flag: Bool) {
        super.setFrame(frameRect, display: flag)
        (contentView as? PetView)?.refreshInputHit()
        (contentView as? PetView)?.refreshGazeForCurrentBody()
    }
    override func setFrameOrigin(_ point: NSPoint) {
        super.setFrameOrigin(point)
        (contentView as? PetView)?.refreshInputHit()
        (contentView as? PetView)?.refreshGazeForCurrentBody()
    }
    override func orderFrontRegardless() {
        guard allowsPresentation else { return }
        super.orderFrontRegardless()
        (contentView as? PetView)?.refreshInputHit()
        (contentView as? PetView)?.refreshGazeForCurrentBody()
    }
    override func orderOut(_ sender: Any?) {
        super.orderOut(sender)
        (contentView as? PetView)?.refreshInputHit()
        (contentView as? PetView)?.refreshGazeForCurrentBody()
    }
}

final class ChatPanel: NSPanel {
    override var canBecomeKey: Bool { true }
    override var canBecomeMain: Bool { false }
}

// The page reports its non-interactive title area. The native view captures
// only that rectangle, leaving WebKit in charge of the chat and its controls.
final class ChatDragView: NSView {
    static let regionScript = #"""
    (() => {
        const panel = document.getElementById('chat-panel');
        const header = panel?.querySelector('.chat-header');
        const mark = header?.querySelector('.curator-mark');
        const actions = header?.querySelector('.chat-window-actions');
        if (!header || !mark || !actions) return;
        let previous;
        function publish() {
            const title = header.getBoundingClientRect();
            const left = mark.getBoundingClientRect().left;
            const right = actions.getBoundingClientRect().left;
            const region = !panel.hidden && !document.querySelector('dialog[open]') && title.height > 0 && right > left
                ? { left, right, top: title.top, bottom: title.bottom } : null;
            const key = JSON.stringify(region);
            if (key === previous) return;
            previous = key;
            window.webkit.messageHandlers.forme.postMessage({ action: 'chatDragRegion', region });
        }
        const resize = new ResizeObserver(publish);
        for (const element of [header, mark, actions]) resize.observe(element);
        new MutationObserver(publish).observe(panel, { attributes: true, attributeFilter: ['hidden'] });
        new MutationObserver(publish).observe(document.body, { attributes: true, subtree: true, attributeFilter: ['open'] });
        publish();
    })();
    """#

    weak var owner: CuratorApp?
    private var pressedAt: NSPoint?
    private var pressedFrame: NSRect?
    private var dragging = false

    static func region(_ body: [String: Any], in bounds: NSRect) -> NSRect? {
        guard let left = (body["left"] as? NSNumber)?.doubleValue, let right = (body["right"] as? NSNumber)?.doubleValue,
              let top = (body["top"] as? NSNumber)?.doubleValue, let bottom = (body["bottom"] as? NSNumber)?.doubleValue,
              [left, right, top, bottom].allSatisfy(\.isFinite),
              left >= 0, right > left, top >= 0, bottom > top, bottom <= 72 else { return nil }
        let rect = NSRect(x: bounds.minX + left, y: bounds.maxY - bottom,
                          width: right - left, height: bottom - top).intersection(bounds)
        return rect.isEmpty ? nil : rect
    }

    override func acceptsFirstMouse(for event: NSEvent?) -> Bool { true }
    override func resetCursorRects() { addCursorRect(bounds, cursor: .openHand) }

    override func mouseDown(with event: NSEvent) {
        pressedAt = NSEvent.mouseLocation
        pressedFrame = window?.frame
    }

    override func mouseDragged(with event: NSEvent) {
        guard let pressedAt = pressedAt, let pressedFrame = pressedFrame else { return }
        let cursor = NSEvent.mouseLocation
        let dx = cursor.x - pressedAt.x
        let dy = cursor.y - pressedAt.y
        if !dragging {
            guard hypot(dx, dy) >= 4, owner?.beginChatDrag() == true else { return }
            dragging = true
            NSCursor.closedHand.set()
        }
        owner?.moveChatDrag(to: pressedFrame.offsetBy(dx: dx, dy: dy), cursor: cursor)
    }

    override func mouseUp(with event: NSEvent) {
        if dragging {
            owner?.endChatDrag()
            window?.invalidateCursorRects(for: self)
            let point = convert(event.locationInWindow, from: nil)
            (bounds.contains(point) ? NSCursor.openHand : NSCursor.arrow).set()
        }
        dragging = false
        pressedAt = nil
        pressedFrame = nil
    }
}

struct ChatTransition {
    var fromFrame: NSRect
    var toFrame: NSRect
    let fromAlpha: CGFloat
    let toAlpha: CGFloat
    let startedAt: TimeInterval
    let duration: TimeInterval
    let showing: Bool

    func value(at time: TimeInterval) -> (frame: NSRect, alpha: CGFloat, complete: Bool) {
        let elapsed = max(time - startedAt, 0)
        let complete = duration <= 0 || elapsed >= duration - 0.000001
        let progress = complete ? 1 : min(elapsed / duration, 1)
        let eased = CGFloat(1 - pow(1 - progress, 3))
        let frame = NSRect(x: fromFrame.minX + (toFrame.minX - fromFrame.minX) * eased,
                           y: fromFrame.minY + (toFrame.minY - fromFrame.minY) * eased,
                           width: fromFrame.width + (toFrame.width - fromFrame.width) * eased,
                           height: fromFrame.height + (toFrame.height - fromFrame.height) * eased)
        return (frame, fromAlpha + (toAlpha - fromAlpha) * eased, complete)
    }
}

struct PetScalarTransition {
    let from: CGFloat
    let to: CGFloat
    let startedAt: TimeInterval
    let duration: TimeInterval

    func value(at time: TimeInterval) -> (amount: CGFloat, complete: Bool) {
        let elapsed = max(time - startedAt, 0)
        let complete = duration <= 0 || elapsed >= duration - 0.000001
        let progress = complete ? 1 : min(elapsed / duration, 1)
        let eased = CGFloat(1 - pow(1 - progress, 3))
        return (from + (to - from) * eased, complete)
    }
}

struct PetPose {
    let translation: NSPoint
    let scale: NSSize
    let tilt: CGFloat
    let eyeOpenness: CGFloat
}

struct PetContact {
    let point: NSPoint
    let normal: CGVector
    let edge: DockEdge
    let isWindow: Bool

    var standOff: CGFloat { PetDockGeometry.standOff(normal: normal, isWindow: isWindow) }

    var hoverEdge: DockEdge {
        if normal.dx > 0 { return .left }
        if normal.dx < 0 { return .right }
        return normal.dy > 0 ? .bottom : .top
    }
}

struct PetDockPlacement {
    let frame: NSRect
    let contact: PetContact
}

struct PetWindowAnchor {
    let edge: DockEdge
    let fraction: CGFloat
}

struct PetDockTransition {
    let fromFrame: NSRect
    let toFrame: NSRect
    let startedAt: TimeInterval
    let duration: TimeInterval
    var initialVelocity: CGVector = .zero

    func velocity(at time: TimeInterval) -> CGVector {
        guard duration > 0, time < startedAt + duration else { return .zero }
        let t = PetMotion.unit(CGFloat((time - startedAt) / duration))
        let d = CGFloat(duration)
        let slope = 6 * t * (1 - t) / d
        let carry = 3 * t * t - 4 * t + 1
        return CGVector(dx: (toFrame.minX - fromFrame.minX) * slope + initialVelocity.dx * carry,
                        dy: (toFrame.minY - fromFrame.minY) * slope + initialVelocity.dy * carry)
    }

    func value(at time: TimeInterval) -> (frame: NSRect, contact: CGFloat, complete: Bool) {
        let elapsed = max(time - startedAt, 0)
        let complete = duration <= 0 || elapsed >= duration - 0.000001
        let progress = complete ? CGFloat(1) : PetMotion.unit(CGFloat(elapsed / duration))
        let eased = progress * progress * (3 - 2 * progress)
        let carry = progress * (1 - progress) * (1 - progress) * CGFloat(duration)
        let frame = NSRect(x: fromFrame.minX + (toFrame.minX - fromFrame.minX) * eased + initialVelocity.dx * carry,
                           y: fromFrame.minY + (toFrame.minY - fromFrame.minY) * eased + initialVelocity.dy * carry,
                           width: toFrame.width, height: toFrame.height)
        let contactProgress = PetMotion.unit(progress / 0.9)
        let contact = contactProgress * contactProgress * (3 - 2 * contactProgress)
        return (frame, contact, complete)
    }
}

enum PetDockGeometry {
    static let center = NSPoint(x: 36, y: 43)
    static let size = NSSize(width: 72, height: 84)
    static let standOff: CGFloat = 16

    static func standOff(normal: CGVector, isWindow: Bool) -> CGFloat {
        guard isWindow else { return standOff }
        let layout = CompanionResource.layout
        let scale = layout.nativeBodyWidth / layout.bodyBounds.width
        // A tiny overlap hides the antialiased contact seam; screen entries retain 16pt.
        return (abs(normal.dx) * layout.bodyBounds.width + abs(normal.dy) * layout.bodyBounds.height) * scale / 2 - 0.12
    }

    static func inward(_ edge: DockEdge) -> CGVector {
        switch edge {
        case .left: return CGVector(dx: 1, dy: 0)
        case .right: return CGVector(dx: -1, dy: 0)
        case .top: return CGVector(dx: 0, dy: -1)
        case .bottom: return CGVector(dx: 0, dy: 1)
        }
    }

    static func clamp(_ value: CGFloat, low: CGFloat, high: CGFloat) -> CGFloat {
        low <= high ? min(max(value, low), high) : (low + high) / 2
    }

    static func placement(at point: NSPoint, normal: CGVector, edge: DockEdge, isWindow: Bool) -> PetDockPlacement {
        let distance = standOff(normal: normal, isWindow: isWindow)
        let origin = NSPoint(x: point.x + normal.dx * distance - center.x, y: point.y + normal.dy * distance - center.y)
        return PetDockPlacement(frame: NSRect(origin: origin, size: size),
            contact: PetContact(point: point, normal: normal, edge: edge, isWindow: isWindow))
    }

    static func screen(edge: DockEdge, near point: NSPoint, in screen: NSRect) -> PetDockPlacement {
        let x = clamp(point.x, low: screen.minX + center.x, high: screen.maxX - (size.width - center.x))
        let y = clamp(point.y, low: screen.minY + center.y, high: screen.maxY - (size.height - center.y))
        let contact: NSPoint
        switch edge {
        case .left: contact = NSPoint(x: screen.minX, y: y)
        case .right: contact = NSPoint(x: screen.maxX, y: y)
        case .top: contact = NSPoint(x: x, y: screen.maxY)
        case .bottom: contact = NSPoint(x: x, y: screen.minY)
        }
        return placement(at: contact, normal: inward(edge), edge: edge, isWindow: false)
    }

    static func anchor(for window: NSRect, near point: NSPoint, in screen: NSRect) -> PetWindowAnchor {
        let candidates: [(DockEdge, CGFloat, Bool)] = [
            (.top, abs(point.y - window.maxY), window.maxY >= screen.minY && window.maxY <= screen.maxY),
            (.right, abs(point.x - window.maxX), window.maxX >= screen.minX && window.maxX <= screen.maxX),
            (.bottom, abs(point.y - window.minY), window.minY >= screen.minY && window.minY <= screen.maxY),
            (.left, abs(point.x - window.minX), window.minX >= screen.minX && window.minX <= screen.maxX),
        ]
        let visible = candidates.filter { $0.2 }
        let edge = (visible.isEmpty ? candidates : visible).min { $0.1 < $1.1 }!.0
        let fraction: CGFloat
        switch edge {
        case .top, .bottom: fraction = (point.x - window.minX) / max(window.width, 1)
        case .left, .right: fraction = (point.y - window.minY) / max(window.height, 1)
        }
        return PetWindowAnchor(edge: edge, fraction: PetMotion.unit(fraction))
    }

    static func topContactRange(_ frame: NSRect, in screen: NSRect) -> (low: CGFloat, high: CGFloat) {
        (max(frame.minX + 96, screen.minX + center.x),
         min(frame.maxX - (size.width - center.x), screen.maxX - (size.width - center.x)))
    }

    static func window(_ frame: NSRect, anchor: PetWindowAnchor, in screen: NSRect,
                       previousNormal: CGVector? = nil) -> PetDockPlacement {
        // A real window always owns the card on its inside, regardless of display clearance.
        // Keep the optional previous normal only for callers carrying an older placement.
        let normal = inward(anchor.edge)
        let horizontalInset: CGFloat = anchor.edge == .top ? 96 : center.x
        let horizontal = anchor.edge == .top ? topContactRange(frame, in: screen)
            : (low: max(frame.minX + horizontalInset, screen.minX + center.x),
               high: min(frame.maxX - (size.width - center.x), screen.maxX - (size.width - center.x)))
        let x = clamp(frame.minX + frame.width * anchor.fraction, low: horizontal.low, high: horizontal.high)
        let y = clamp(frame.minY + frame.height * anchor.fraction,
                      low: max(frame.minY + center.y, screen.minY + center.y),
                      high: min(frame.maxY - (size.height - center.y), screen.maxY - (size.height - center.y)))
        let point: NSPoint
        switch anchor.edge {
        case .top: point = NSPoint(x: x, y: frame.maxY)
        case .bottom: point = NSPoint(x: x, y: frame.minY)
        case .left: point = NSPoint(x: frame.minX, y: y)
        case .right: point = NSPoint(x: frame.maxX, y: y)
        }
        return placement(at: point, normal: normal, edge: anchor.edge, isWindow: true)
    }
}

struct PetCurve {
    let end: NSPoint
    let first: NSPoint
    let second: NSPoint
}

struct PetContour {
    let start: NSPoint
    let curves: [PetCurve]
}

struct CompanionPoint: Decodable {
    let x: CGFloat
    let y: CGFloat
}

struct CompanionExtent: Decodable {
    let width: CGFloat
    let height: CGFloat
}

struct CompanionRectangle: Decodable {
    let x: CGFloat
    let y: CGFloat
    let width: CGFloat
    let height: CGFloat
    var rect: NSRect { NSRect(x: x, y: y, width: width, height: height) }
}

struct CompanionEye: Decodable {
    let name: String
    let cx: CGFloat
    let cy: CGFloat
    let width: CGFloat
    let height: CGFloat
    let angle: CGFloat
}

struct CompanionGaze: Decodable {
    let maximumOffset: CGFloat
    let maximumVerticalOffset: CGFloat
    let reachBodyScale: CGFloat
    let responseMs: Double
    let returnMs: Double
    let idleMs: Double
}

struct CompanionLayout: Decodable {
    let version: Int
    let source: String
    let canvas: CompanionExtent
    let viewport: CompanionRectangle
    let bodyBounds: CompanionRectangle
    let windowBounds: CompanionRectangle
    let eyeSafeBounds: CompanionRectangle
    let faceCenter: CompanionPoint
    let eyes: [CompanionEye]
    let gaze: CompanionGaze
    let nativeBodyWidth: CGFloat
}

enum CompanionResource {
    // Decode once. Bundled releases and local native review use exactly the same PNG/JSON pair.
    static let directory: URL = {
        let manager = FileManager.default
        if let bundled = Bundle.main.resourceURL,
           manager.fileExists(atPath: bundled.appendingPathComponent("companion-shell.png").path),
           manager.fileExists(atPath: bundled.appendingPathComponent("companion-layout.json").path) { return bundled }
        return URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent()
            .deletingLastPathComponent().appendingPathComponent("site/curator", isDirectory: true)
    }()

    static let layout: CompanionLayout = {
        let url = directory.appendingPathComponent("companion-layout.json")
        do {
            let layout = try JSONDecoder().decode(CompanionLayout.self, from: Data(contentsOf: url))
            precondition(layout.version >= 2 && layout.eyes.count == 2 && layout.bodyBounds.width > 0
                && layout.bodyBounds.height > 0 && layout.nativeBodyWidth > 0, "Folio 的伙伴布局资源无效")
            return layout
        } catch { fatalError("无法读取 Folio 伙伴布局：\(error.localizedDescription)") }
    }()

    static let image: CGImage = {
        let url = directory.appendingPathComponent("companion-shell.png")
        guard let source = CGImageSourceCreateWithURL(url as CFURL, nil),
              let image = CGImageSourceCreateImageAtIndex(source, 0,
                [kCGImageSourceShouldCacheImmediately: true] as CFDictionary) else {
            fatalError("无法读取 Folio 伙伴外壳资源")
        }
        precondition(image.width == Int(layout.canvas.width) && image.height == Int(layout.canvas.height),
                     "Folio 伙伴外壳与布局画布不匹配")
        return image
    }()
}

struct PetFilletColor {
    let red: CGFloat
    let green: CGFloat
    let blue: CGFloat
    var components: [CGFloat] { [red, green, blue] }
    func color(alpha: CGFloat) -> NSColor { NSColor(srgbRed: red, green: green, blue: blue, alpha: alpha) }
    func mixed(with other: PetFilletColor, amount: CGFloat) -> PetFilletColor {
        PetFilletColor(red: red + (other.red - red) * amount,
                       green: green + (other.green - green) * amount,
                       blue: blue + (other.blue - blue) * amount)
    }
}

struct PetFilletShade {
    let start: NSPoint
    let end: NSPoint
    let colors: [PetFilletColor]
}

enum PetFilletMaterial {
    static let depth: CGFloat = 10.6
    static let outwardReach: CGFloat = 8.6
    private static let normals = [CGVector(dx: 1, dy: 0), CGVector(dx: -1, dy: 0),
                                  CGVector(dx: 0, dy: 1), CGVector(dx: 0, dy: -1)]
    // NSBitmapImageRep handles the source image's alpha/byte order. No pixel reads occur in draw/morph.
    private static let bands: [[[PetFilletColor]]] = {
        let bitmap = NSBitmapImageRep(cgImage: CompanionResource.image)
        let layout = CompanionResource.layout, body = layout.bodyBounds.rect
        let scale = layout.nativeBodyWidth / body.width
        func color(_ p: NSPoint) -> NSColor? {
            let x = min(max(Int(p.x.rounded()), 0), bitmap.pixelsWide - 1)
            let y = min(max(Int(p.y.rounded()), 0), bitmap.pixelsHigh - 1)
            return bitmap.colorAt(x: x, y: y)?.usingColorSpace(.sRGB)
        }
        return normals.map { normal in
            let tangent = CGVector(dx: normal.dy, dy: -normal.dx)
            let half = (abs(tangent.dx) * body.width + abs(tangent.dy) * body.height) * scale / 2
            let distance = PetDockGeometry.standOff(normal: normal, isWindow: true)
            return [CGFloat(1), CGFloat(-1)].map { side in
                var previous = PetFilletColor(red: 0.19, green: 0.19, blue: 0.20)
                return (0...24).map { index in
                    // At the contact seam the opaque shell begins just inside its antialiased extremum.
                    let v = max(0.25, depth * CGFloat(index) / 24)
                    func source(_ u: CGFloat) -> NSPoint {
                        let x = tangent.dx * u + normal.dx * (v - distance)
                        let y = tangent.dy * u + normal.dy * (v - distance)
                        return NSPoint(x: body.midX + x / scale, y: body.midY - y / scale)
                    }
                    var u = half + scale
                    while u >= 0 {
                        if let edge = color(source(side * u)), edge.alphaComponent >= 0.985,
                           let inside = color(source(side * max(u - 2 * scale, 0))), inside.alphaComponent >= 0.985 {
                            previous = PetFilletColor(red: inside.redComponent, green: inside.greenComponent, blue: inside.blueComponent)
                            break
                        }
                        u -= scale
                    }
                    return previous
                }
            }
        }
    }()

    static func colors(normal: CGVector, index: Int) -> [PetFilletColor] {
        let direction = normals.firstIndex { $0 == normal } ?? 0
        return bands[direction][index]
    }

    static let neutralColors = Array(repeating: PetFilletColor(red: 0.19, green: 0.19, blue: 0.20), count: 25)

    // A small runtime mask softens only the old outer rim under the two dynamic shoulders.
    // The inset face and lower printed features are >2.3pt from this outer silhouette.
    static func rimBlendWeight(at source: NSPoint) -> CGFloat {
        let layout = CompanionResource.layout, body = layout.bodyBounds.rect
        let scale = layout.nativeBodyWidth / body.width
        if layout.windowBounds.rect.contains(source) { return 0 }
        let radius: CGFloat = 4.6
        let x = abs((source.x - body.midX) * scale) - (body.width * scale / 2 - radius)
        let y = abs((source.y - body.midY) * scale) - (body.height * scale / 2 - radius)
        let signedDistance = hypot(max(x, 0), max(y, 0)) + min(max(x, y), 0) - radius
        let inside = PetMotion.unit(max(-signedDistance, 0) / 2.3)
        return 1 - inside * inside * (3 - 2 * inside)
    }

    static let rimBlendMask: (image: CGImage, rect: CGRect) = {
        let layout = CompanionResource.layout, body = layout.bodyBounds.rect
        let scale = layout.nativeBodyWidth / body.width
        let rect = CGRect(x: body.midX - 36 / scale, y: body.midY - 41 / scale,
                          width: 72 / scale, height: 84 / scale)
        let width = 288, height = 336
        var pixels = [UInt8](repeating: 0, count: width * height)
        for y in 0..<height {
            for x in 0..<width {
                let source = NSPoint(x: rect.minX + (CGFloat(x) + 0.5) * rect.width / CGFloat(width),
                                     y: rect.minY + (CGFloat(y) + 0.5) * rect.height / CGFloat(height))
                pixels[y * width + x] = UInt8((rimBlendWeight(at: source) * 255).rounded())
            }
        }
        let provider = CGDataProvider(data: Data(pixels) as CFData)!
        // Image masks normally invert coverage; decode reverses that so 255 means full blending.
        let image = CGImage(maskWidth: width, height: height, bitsPerComponent: 8, bitsPerPixel: 8,
            bytesPerRow: width, provider: provider, decode: [1, 0], shouldInterpolate: true)!
        return (image, rect)
    }()
}

struct PetArtwork {
    let contour: PetContour
    let mascot: PetContour
    let fillets: [PetContour]
    let filletShades: [PetFilletShade]
    let face: NSPoint
    let baseOpacity: CGFloat
    let adhesionAmount: CGFloat
    // Three affine anchors keep every printed feature glued to the living plaque.
    let labelOrigin: NSPoint
    let labelX: NSPoint
    let labelY: NSPoint

    func adoptingAdhesion(_ other: PetArtwork) -> PetArtwork {
        PetArtwork(contour: contour, mascot: mascot, fillets: other.fillets, filletShades: other.filletShades,
            face: face, baseOpacity: baseOpacity, adhesionAmount: other.adhesionAmount,
            labelOrigin: labelOrigin, labelX: labelX, labelY: labelY)
    }

    func labelPoint(_ x: CGFloat, _ y: CGFloat) -> NSPoint {
        NSPoint(x: labelOrigin.x + (labelX.x - labelOrigin.x) * x + (labelY.x - labelOrigin.x) * y,
                y: labelOrigin.y + (labelX.y - labelOrigin.y) * x + (labelY.y - labelOrigin.y) * y)
    }
}

enum PetMotion {
    static func unit(_ value: CGFloat) -> CGFloat { min(max(value, 0), 1) }

    static func mix(_ a: NSPoint, _ b: NSPoint, _ amount: CGFloat) -> NSPoint {
        NSPoint(x: a.x + (b.x - a.x) * amount, y: a.y + (b.y - a.y) * amount)
    }

    static let freeContour = PetContour(start: PetDockGeometry.center,
        curves: Array(repeating: PetCurve(end: PetDockGeometry.center, first: PetDockGeometry.center,
                                          second: PetDockGeometry.center), count: 8))

    // An unobtrusive 18x2 warm-gray contact marker. It never surrounds the card.
    // Split the two straight runs so all eight closed joins retain exact C1 handles.
    static let contactContour: PetContour = {
        let handle: CGFloat = 0.5522847498307936
        return PetContour(start: NSPoint(x: -8, y: 0.2), curves: [
            PetCurve(end: NSPoint(x: 0, y: 0.2), first: NSPoint(x: -8 + handle, y: 0.2), second: NSPoint(x: -handle, y: 0.2)),
            PetCurve(end: NSPoint(x: 8, y: 0.2), first: NSPoint(x: handle, y: 0.2), second: NSPoint(x: 8 - handle, y: 0.2)),
            PetCurve(end: NSPoint(x: 9, y: 1.2), first: NSPoint(x: 8 + handle, y: 0.2), second: NSPoint(x: 9, y: 1.2 - handle)),
            PetCurve(end: NSPoint(x: 8, y: 2.2), first: NSPoint(x: 9, y: 1.2 + handle), second: NSPoint(x: 8 + handle, y: 2.2)),
            PetCurve(end: NSPoint(x: 0, y: 2.2), first: NSPoint(x: 8 - handle, y: 2.2), second: NSPoint(x: handle, y: 2.2)),
            PetCurve(end: NSPoint(x: -8, y: 2.2), first: NSPoint(x: -handle, y: 2.2), second: NSPoint(x: -8 + handle, y: 2.2)),
            PetCurve(end: NSPoint(x: -9, y: 1.2), first: NSPoint(x: -8 - handle, y: 2.2), second: NSPoint(x: -9, y: 1.2 + handle)),
            PetCurve(end: NSPoint(x: -8, y: 0.2), first: NSPoint(x: -9, y: 1.2 - handle), second: NSPoint(x: -8 - handle, y: 0.2)),
        ])
    }()

    // Two separate corner adhesions. There is deliberately no filled path between them.
    // Canonical x follows the edge; canonical y points into the owning window.
    static func adhesionContours(normal: CGVector) -> [PetContour] {
        let body = CompanionResource.layout.bodyBounds
        let half = (abs(normal.dy) * body.width + abs(normal.dx) * body.height) * labelScale / 2
        func right(_ p: NSPoint, mirror: Bool) -> NSPoint { NSPoint(x: mirror ? -p.x : p.x, y: p.y) }
        return [false, true].map { mirror in
            func p(_ x: CGFloat, _ y: CGFloat) -> NSPoint { right(NSPoint(x: half + x, y: y), mirror: mirror) }
            return PetContour(start: p(8.6, 0), curves: [
                // A single concave shoulder begins high on the side wall; the shell hides its inner overlap.
                PetCurve(end: p(-0.25, 10.6), first: p(2.8, 0), second: p(-0.25, 6.1)),
                PetCurve(end: p(-2.6, 10.6), first: p(-1.0, 10.6), second: p(-1.8, 10.6)),
                PetCurve(end: p(-8, 0), first: p(-2.6, 6.1), second: p(-5.7, 0)),
                PetCurve(end: p(8.6, 0), first: p(-3.0, 0), second: p(3.1, 0)),
            ])
        }
    }

    static let freeFillet = PetContour(start: PetDockGeometry.center,
        curves: Array(repeating: PetCurve(end: PetDockGeometry.center, first: PetDockGeometry.center,
                                          second: PetDockGeometry.center), count: 4))

    // The approved asset's source pixels define the geometry; never re-center its eyes or re-draw its shell.
    static let labelScale: CGFloat = CompanionResource.layout.nativeBodyWidth / CompanionResource.layout.bodyBounds.width
    static func labelCoordinate(_ x: CGFloat, _ y: CGFloat) -> NSPoint {
        let body = CompanionResource.layout.bodyBounds.rect
        return NSPoint(x: (x - body.midX) * labelScale, y: (body.midY - y) * labelScale)
    }
    static let mascotContour: PetContour = {
        // Conservative viewport extent for interpolation/canvas checks only. It is never painted.
        let box = CompanionResource.layout.viewport.rect
        let corners = [NSPoint(x: box.minX, y: box.minY), NSPoint(x: box.midX, y: box.minY),
            NSPoint(x: box.maxX, y: box.minY), NSPoint(x: box.maxX, y: box.midY),
            NSPoint(x: box.maxX, y: box.maxY), NSPoint(x: box.midX, y: box.maxY),
            NSPoint(x: box.minX, y: box.maxY), NSPoint(x: box.minX, y: box.midY)]
        let points = corners.map { labelCoordinate($0.x, $0.y) }
        let curves = points.indices.map { index -> PetCurve in
            let a = points[index], b = points[(index + 1) % points.count]
            return PetCurve(end: b, first: mix(a, b, 1 / 3), second: mix(a, b, 2 / 3))
        }
        return PetContour(start: points[0], curves: curves)
    }()

    static func contactOrigin(_ contact: PetContact, frame: NSRect, amount: CGFloat) -> NSPoint {
        let free = NSPoint(x: 36 - contact.normal.dx * contact.standOff, y: 43 - contact.normal.dy * contact.standOff)
        let actual = NSPoint(x: contact.point.x - frame.minX, y: contact.point.y - frame.minY)
        return mix(free, actual, unit(amount))
    }

    static func faceCenter(contact: PetContact?, frame: NSRect, amount: CGFloat, pose: PetPose) -> NSPoint {
        guard let contact = contact else { return NSPoint(x: 36 + pose.translation.x, y: 43 + pose.translation.y) }
        let origin = contactOrigin(contact, frame: frame, amount: amount)
        return NSPoint(x: origin.x + contact.normal.dx * contact.standOff + pose.translation.x,
                       y: origin.y + contact.normal.dy * contact.standOff + pose.translation.y)
    }

    static func transformed(_ point: NSPoint, around center: NSPoint, pose: PetPose) -> NSPoint {
        let x = (point.x - center.x) * pose.scale.width
        let y = (point.y - center.y) * pose.scale.height
        let cosine = cos(pose.tilt), sine = sin(pose.tilt)
        return NSPoint(x: center.x + x * cosine - y * sine + pose.translation.x,
                       y: center.y + x * sine + y * cosine + pose.translation.y)
    }

    static func contour(contact: PetContact?, frame: NSRect, amount: CGFloat, pose: PetPose) -> PetContour {
        let amount = unit(amount)
        let origin = contact.map { contactOrigin($0, frame: frame, amount: amount) }
        func point(_ free: NSPoint, _ docked: NSPoint) -> NSPoint {
            guard let contact = contact, let origin = origin else {
                return transformed(free, around: PetDockGeometry.center, pose: pose)
            }
            let tangent = CGVector(dx: contact.normal.dy, dy: -contact.normal.dx)
            let offset = NSPoint(x: free.x - 36, y: free.y - 43)
            let canonicalFree = NSPoint(x: offset.x * tangent.dx + offset.y * tangent.dy,
                                        y: offset.x * contact.normal.dx + offset.y * contact.normal.dy + contact.standOff)
            let local = mix(canonicalFree, docked, amount)
            let mapped = NSPoint(x: origin.x + tangent.dx * local.x + contact.normal.dx * local.y,
                                 y: origin.y + tangent.dy * local.x + contact.normal.dy * local.y)
            let center = NSPoint(x: origin.x + contact.normal.dx * contact.standOff, y: origin.y + contact.normal.dy * contact.standOff)
            let moved = transformed(mapped, around: center, pose: pose)
            let distance = unit(local.y / 15)
            let blend = distance * distance * (3 - 2 * distance)
            // The edge and its two tangents stay fixed while the face can peek or squash.
            return mix(moved, mapped, amount * (1 - blend))
        }
        let selectedContour = contact?.isWindow == true ? PetContour(start: .zero, curves: Array(repeating: PetCurve(end: .zero, first: .zero, second: .zero), count: 8)) : contactContour
        let curves = zip(freeContour.curves, selectedContour.curves).map { free, docked in
            PetCurve(end: point(free.end, docked.end), first: point(free.first, docked.first), second: point(free.second, docked.second))
        }
        return PetContour(start: point(freeContour.start, selectedContour.start), curves: curves)
    }

    static func artwork(contact: PetContact?, frame: NSRect, pose: PetPose) -> PetArtwork {
        let amount: CGFloat = contact == nil ? 0 : 1
        let rest = PetPose(translation: .zero, scale: NSSize(width: 1, height: 1), tilt: 0, eyeOpenness: pose.eyeOpenness)
        let animatedPose = PetPose(translation: NSPoint(x: pose.translation.x * 0.35, y: pose.translation.y * 0.35),
            scale: NSSize(width: 1 + (pose.scale.width - 1) * 0.7, height: 1 + (pose.scale.height - 1) * 0.7),
            tilt: pose.tilt, eyeOpenness: pose.eyeOpenness)
        // Window corners stay glued while hover/press communicate through the eyes.
        let lightPose = contact?.isWindow == true ? rest : animatedPose
        let face = faceCenter(contact: contact, frame: frame, amount: amount, pose: lightPose)
        func point(_ value: NSPoint) -> NSPoint {
            let scaled = NSPoint(x: value.x * lightPose.scale.width, y: value.y * lightPose.scale.height)
            return NSPoint(x: face.x + scaled.x * cos(lightPose.tilt) - scaled.y * sin(lightPose.tilt),
                           y: face.y + scaled.x * sin(lightPose.tilt) + scaled.y * cos(lightPose.tilt))
        }
        let mascot = PetContour(start: point(mascotContour.start), curves: mascotContour.curves.map {
            PetCurve(end: point($0.end), first: point($0.first), second: point($0.second))
        })
        let fillets: [PetContour]
        let shades: [PetFilletShade]
        if let contact = contact, contact.isWindow {
            let origin = contactOrigin(contact, frame: frame, amount: amount)
            let tangent = CGVector(dx: contact.normal.dy, dy: -contact.normal.dx)
            func map(_ p: NSPoint) -> NSPoint {
                NSPoint(x: origin.x + tangent.dx * p.x + contact.normal.dx * p.y,
                        y: origin.y + tangent.dy * p.x + contact.normal.dy * p.y)
            }
            fillets = adhesionContours(normal: contact.normal).map { curve in
                PetContour(start: map(curve.start), curves: curve.curves.map {
                    PetCurve(end: map($0.end), first: map($0.first), second: map($0.second))
                })
            }
            shades = (0...1).map { index in
                PetFilletShade(start: map(.zero), end: map(NSPoint(x: 0, y: PetFilletMaterial.depth)),
                               colors: PetFilletMaterial.colors(normal: contact.normal, index: index))
            }
        } else {
            fillets = [freeFillet, freeFillet]
            shades = Array(repeating: PetFilletShade(start: PetDockGeometry.center, end: PetDockGeometry.center,
                colors: PetFilletMaterial.neutralColors), count: 2)
        }
        return PetArtwork(contour: contour(contact: contact, frame: frame, amount: amount, pose: rest),
                          mascot: mascot, fillets: fillets, filletShades: shades, face: face, baseOpacity: contact?.isWindow == true ? 0 : amount, adhesionAmount: contact?.isWindow == true ? 1 : 0,
                          labelOrigin: point(labelCoordinate(0, 0)),
                          labelX: point(labelCoordinate(1, 0)), labelY: point(labelCoordinate(0, 1)))
    }

    static func interpolate(_ from: PetArtwork, _ to: PetArtwork, amount: CGFloat) -> PetArtwork {
        let amount = unit(amount)
        func contour(_ a: PetContour, _ b: PetContour) -> PetContour {
            let curves = zip(a.curves, b.curves).map { a, b in
                PetCurve(end: mix(a.end, b.end, amount), first: mix(a.first, b.first, amount), second: mix(a.second, b.second, amount))
            }
            return PetContour(start: mix(a.start, b.start, amount), curves: curves)
        }
        return PetArtwork(contour: contour(from.contour, to.contour), mascot: contour(from.mascot, to.mascot),
                          fillets: zip(from.fillets, to.fillets).map { contour($0, $1) },
                          filletShades: zip(from.filletShades, to.filletShades).map { a, b in
                              PetFilletShade(start: mix(a.start, b.start, amount), end: mix(a.end, b.end, amount),
                                  colors: zip(a.colors, b.colors).map { $0.mixed(with: $1, amount: amount) })
                          },
                          face: mix(from.face, to.face, amount), baseOpacity: from.baseOpacity + (to.baseOpacity - from.baseOpacity) * amount,
                          adhesionAmount: from.adhesionAmount + (to.adhesionAmount - from.adhesionAmount) * amount,
                          labelOrigin: mix(from.labelOrigin, to.labelOrigin, amount),
                          labelX: mix(from.labelX, to.labelX, amount), labelY: mix(from.labelY, to.labelY, amount))
    }

    static func release(at progress: CGFloat) -> CGFloat {
        guard progress > 0, progress < 1 else { return 0 }
        return sin(progress * .pi * 2.4) * exp(-progress * 5)
    }

    static func pose(edge: DockEdge?, hover: CGFloat, press: CGFloat, drag: CGVector,
                     releaseProgress: CGFloat, blinkProgress: CGFloat, reducedMotion: Bool) -> PetPose {
        if reducedMotion { return PetPose(translation: .zero, scale: NSSize(width: 1, height: 1), tilt: 0, eyeOpenness: 1) }
        let dx = min(max(drag.dx, -1), 1), dy = min(max(drag.dy, -1), 1)
        let energy = min(hypot(dx, dy), 1)
        let h = unit(hover) * (1 - energy), p = unit(press)
        let rebound = release(at: unit(releaseProgress))
        var translation = NSPoint(x: 0, y: edge == nil ? h * 1.2 : 0)
        switch edge {
        case .left: translation.x = 5 * h
        case .right: translation.x = -5 * h
        case .top: translation.y = -4.5 * h
        case .bottom: translation.y = 4.5 * h
        case nil: break
        }
        translation.x += dx * 0.8
        translation.y += dy * 0.8 - p * (1 - energy) + rebound * 0.7
        let squeezed: CGFloat = p * (1 - energy)
        let horizontalStretch: CGFloat = abs(dx) * 0.07 - abs(dy) * 0.035
        let verticalStretch: CGFloat = abs(dy) * 0.09 - abs(dx) * 0.035
        let scaleX: CGFloat = 1 + squeezed * 0.04 + horizontalStretch + rebound * 0.035
        let scaleY: CGFloat = 1 - squeezed * 0.075 + verticalStretch - rebound * 0.05
        let scale = NSSize(width: scaleX, height: scaleY)
        let closure = pow(sin(unit(blinkProgress) * .pi), 2)
        return PetPose(translation: translation, scale: scale, tilt: -dx * 0.055,
                       eyeOpenness: max(0, 1 - closure) * (1 - p * 0.12 * (1 - energy)))
    }

    static func deliveryAnchor(edge: DockEdge?) -> NSPoint {
        switch edge {
        case .left: return NSPoint(x: 49, y: 59)
        case .right: return NSPoint(x: 24, y: 59)
        case .top: return NSPoint(x: 49, y: 30)
        case .bottom: return NSPoint(x: 49, y: 61)
        case nil: return NSPoint(x: 54, y: 62)
        }
    }
}

enum PetDragAdhesion {
    static let approachDistance: CGFloat = 15

    static func preview(base: PetArtwork, frame: NSRect, contact: PetContact?) -> PetArtwork {
        guard let contact = contact, contact.isWindow else { return base }
        let normal = contact.normal, tangent = CGVector(dx: normal.dy, dy: -normal.dx)
        let body = PetInputHitRegion.bodyBounds(base, in: frame)
        let face = NSPoint(x: frame.minX + base.face.x, y: frame.minY + base.face.y)
        let half = (abs(normal.dx) * body.width + abs(normal.dy) * body.height) / 2
        let gap = (face.x - contact.point.x) * normal.dx + (face.y - contact.point.y) * normal.dy - half + 0.12
        let sideways = (face.x - contact.point.x) * tangent.dx + (face.y - contact.point.y) * tangent.dy
        guard gap >= -0.5, gap < approachDistance, abs(sideways) <= 2 else { return base }
        let proximity = PetMotion.unit(1 - max(gap, 0) / approachDistance)
        let amount = proximity * proximity * (3 - 2 * proximity)
        let depth = PetFilletMaterial.depth + max(gap, 0)
        let origin = NSPoint(x: contact.point.x - frame.minX, y: contact.point.y - frame.minY)
        func map(_ point: NSPoint) -> NSPoint {
            let stretched = point.y * depth / PetFilletMaterial.depth
            return NSPoint(x: origin.x + tangent.dx * point.x + normal.dx * stretched,
                           y: origin.y + tangent.dy * point.x + normal.dy * stretched)
        }
        let fillets = PetMotion.adhesionContours(normal: normal).map { contour in
            PetContour(start: map(contour.start), curves: contour.curves.map {
                PetCurve(end: map($0.end), first: map($0.first), second: map($0.second))
            })
        }
        let controlPoints = fillets.flatMap { [$0.start] + $0.curves.flatMap { [$0.end, $0.first, $0.second] } }
        guard controlPoints.allSatisfy({ $0.x >= 0 && $0.x <= PetDockGeometry.size.width && $0.y >= 0 && $0.y <= PetDockGeometry.size.height }) else { return base }
        let shades = (0...1).map { PetFilletShade(start: origin, end: map(NSPoint(x: 0, y: PetFilletMaterial.depth)),
            colors: PetFilletMaterial.colors(normal: normal, index: $0)) }
        let overlay = PetArtwork(contour: base.contour, mascot: base.mascot, fillets: fillets, filletShades: shades,
            face: base.face, baseOpacity: base.baseOpacity, adhesionAmount: amount,
            labelOrigin: base.labelOrigin, labelX: base.labelX, labelY: base.labelY)
        return base.adoptingAdhesion(overlay)
    }
}

struct PetGazeTrackingSample: Equatable {
    let pointer: NSPoint
    let face: NSPoint
    let reaches: NSSize
}

enum PetGaze {
    static let maximumOffset = CompanionResource.layout.gaze.maximumOffset
    static let maximumVerticalOffset = CompanionResource.layout.gaze.maximumVerticalOffset
    static let reachBodyScale = CompanionResource.layout.gaze.reachBodyScale
    static let responseDuration = CompanionResource.layout.gaze.responseMs / 1000
    static let returnDuration = CompanionResource.layout.gaze.returnMs / 1000
    static let returnDelay = CompanionResource.layout.gaze.idleMs / 1000

    static func target(pointer: NSPoint, center: NSPoint, screen: NSRect, reach: CGFloat? = nil,
                       visible: Bool = true, reducedMotion: Bool = false) -> CGFloat {
        guard visible, !reducedMotion, screen.width > 0, screen.height > 0,
              [pointer.x, pointer.y, center.x, center.y, screen.minX, screen.minY, screen.width, screen.height].allSatisfy({ $0.isFinite }),
              screen.contains(pointer) else { return 0 }
        let fallback = CompanionResource.layout.nativeBodyWidth * reachBodyScale
        let requested = reach.flatMap { $0.isFinite && $0 > 0 ? $0 : nil } ?? fallback
        let delta = pointer.x - center.x
        let available = delta < 0 ? center.x - screen.minX : screen.maxX - center.x
        let localReach = max(min(requested, max(available, 1)), 1)
        return min(max(delta / localReach, -1), 1) * maximumOffset
    }

    static func clampedOffset(_ offset: CGFloat) -> CGFloat {
        offset.isFinite ? min(max(offset, -maximumOffset), maximumOffset) : 0
    }

    static func targetVertical(pointer: NSPoint, center: NSPoint, screen: NSRect, reach: CGFloat? = nil,
                               visible: Bool = true, reducedMotion: Bool = false) -> CGFloat {
        guard visible, !reducedMotion, screen.width > 0, screen.height > 0,
              [pointer.x, pointer.y, center.x, center.y, screen.minX, screen.minY, screen.width, screen.height].allSatisfy({ $0.isFinite }),
              screen.contains(pointer) else { return 0 }
        let fallback = CompanionResource.layout.bodyBounds.height * PetMotion.labelScale * reachBodyScale
        let requested = reach.flatMap { $0.isFinite && $0 > 0 ? $0 : nil } ?? fallback
        let delta = pointer.y - center.y
        let available = delta < 0 ? center.y - screen.minY : screen.maxY - center.y
        let localReach = max(min(requested, max(available, 1)), 1)
        // Pointer coordinates point up; source-image coordinates point down.
        return -min(max(delta / localReach, -1), 1) * maximumVerticalOffset
    }

    static func localReaches(for artwork: PetArtwork) -> NSSize {
        let body = CompanionResource.layout.bodyBounds.rect
        let origin = artwork.labelPoint(body.minX, body.minY)
        let right = artwork.labelPoint(body.maxX, body.minY)
        let bottom = artwork.labelPoint(body.minX, body.maxY)
        return NSSize(width: hypot(right.x - origin.x, right.y - origin.y) * reachBodyScale,
                      height: hypot(bottom.x - origin.x, bottom.y - origin.y) * reachBodyScale)
    }

    static func clampedVerticalOffset(_ offset: CGFloat) -> CGFloat {
        offset.isFinite ? min(max(offset, -maximumVerticalOffset), maximumVerticalOffset) : 0
    }

    static func eyePath(index: Int, offset: CGFloat, verticalOffset: CGFloat = 0, openness: CGFloat) -> NSBezierPath {
        let eye = CompanionResource.layout.eyes[index]
        let path = NSBezierPath(roundedRect: NSRect(x: -eye.width / 2, y: -eye.height / 2,
            width: eye.width, height: eye.height), xRadius: eye.width / 2, yRadius: eye.width / 2)
        let angle = eye.angle * .pi / 180
        let blink = max(CGFloat(0.1), PetMotion.unit(openness))
        // Preserve each eye's authored center and angle. Only the inner local y-axis blinks.
        let transform = AffineTransform(m11: cos(angle), m12: sin(angle),
            m21: -sin(angle) * blink, m22: cos(angle) * blink,
            tX: eye.cx + clampedOffset(offset), tY: eye.cy + clampedVerticalOffset(verticalOffset))
        path.transform(using: transform)
        return path
    }
}

enum PetHeldExpression {
    static func amount(pressing: Bool, dragging: Bool, pressAmount: CGFloat, reducedMotion: Bool) -> CGFloat {
        if reducedMotion { return pressing || dragging ? 1 : 0 }
        return PetMotion.unit(pressAmount)
    }

    // One filled path morphs a normal capsule into a rounded chevron; there is no alpha overlap.
    static func eyeOutline(index: Int, amount: CGFloat = 1, offset: CGFloat = 0,
                           verticalOffset: CGFloat = 0, openness: CGFloat = 1) -> CGPath {
        let eye = CompanionResource.layout.eyes[index]
        let progress = PetMotion.unit(amount), direction: CGFloat = index == 0 ? 1 : -1
        let halfRun = (eye.height - eye.width) / 2 + (35 - (eye.height - eye.width) / 2) * progress
        let path = CGMutablePath()
        path.move(to: CGPoint(x: -direction * 25 * progress, y: -halfRun))
        path.addLine(to: CGPoint(x: direction * 25 * progress, y: 0))
        path.addLine(to: CGPoint(x: -direction * 25 * progress, y: halfRun))
        let width = eye.width + (26 - eye.width) * progress
        let outline = path.copy(strokingWithWidth: width, lineCap: .round, lineJoin: .round, miterLimit: 2)
        let box = outline.boundingBoxOfPath
        let angle = eye.angle * .pi / 180
        let blink = progress > 0 ? CGFloat(1) : max(CGFloat(0.1), PetMotion.unit(openness))
        let cosine = cos(angle), sine = sin(angle)
        let a = cosine, b = sine, c = -sine * blink, d = cosine * blink
        var authored = CGAffineTransform(a: a, b: b, c: c, d: d,
            tx: eye.cx + PetGaze.clampedOffset(offset) - a * box.midX - c * box.midY,
            ty: eye.cy + PetGaze.clampedVerticalOffset(verticalOffset) - b * box.midX - d * box.midY)
        return outline.copy(using: &authored)!
    }

}

enum PetInputHitRegion {
    static func bodyBounds(_ artwork: PetArtwork, in frame: NSRect) -> NSRect {
        let body = CompanionResource.layout.bodyBounds.rect
        let points = [NSPoint(x: body.minX, y: body.minY), NSPoint(x: body.maxX, y: body.minY),
                      NSPoint(x: body.maxX, y: body.maxY), NSPoint(x: body.minX, y: body.maxY)]
            .map { artwork.labelPoint($0.x, $0.y) }
        return NSRect(x: frame.minX + points.map { $0.x }.min()!, y: frame.minY + points.map { $0.y }.min()!,
                      width: points.map { $0.x }.max()! - points.map { $0.x }.min()!,
                      height: points.map { $0.y }.max()! - points.map { $0.y }.min()!)
    }

    static func bounds(presented: PetArtwork, neutral: PetArtwork, frame: NSRect, padding: CGFloat = 4) -> NSRect {
        // The neutral union prevents hover movement from repeatedly ejecting a stationary pointer.
        var region = bodyBounds(presented, in: frame).union(bodyBounds(neutral, in: frame)).insetBy(dx: -padding, dy: -padding)
        if presented.adhesionAmount > 0.001 {
            for fillet in presented.fillets {
                let path = NSBezierPath(); path.move(to: fillet.start)
                for curve in fillet.curves { path.curve(to: curve.end, controlPoint1: curve.first, controlPoint2: curve.second) }
                path.close()
                region = region.union(path.bounds.offsetBy(dx: frame.minX, dy: frame.minY).insetBy(dx: -0.7, dy: -0.7))
            }
        }
        return region.intersection(frame)
    }

    static func accepts(_ pointer: NSPoint, bounds: NSRect, visible: Bool, enabled: Bool,
                        pressing: Bool, dragging: Bool) -> Bool {
        guard visible, enabled else { return false }
        return pressing || dragging || bounds.contains(pointer)
    }
}

final class PetPointerClicks {
    private var pendingSingleClick: Timer?

    func begin(count: Int) {
        if count >= 2 { cancel() }
        else { pendingSingleClick?.fire() }
    }

    func finish(count: Int, interval: TimeInterval = NSEvent.doubleClickInterval,
                single: @escaping () -> Void, double: () -> Void) {
        cancel()
        if count >= 2 {
            double()
            return
        }
        let timer = Timer(timeInterval: interval, repeats: false) { [weak self] timer in
            guard self?.pendingSingleClick === timer else { return }
            self?.pendingSingleClick = nil
            single()
        }
        pendingSingleClick = timer
        RunLoop.main.add(timer, forMode: .common)
    }

    func cancel() {
        pendingSingleClick?.invalidate()
        pendingSingleClick = nil
    }

    deinit { cancel() }
}

final class PetView: NSView {
    weak var owner: CuratorApp?
    var dragging = false
    var attached = false { didSet { if attached { dockEdge = nil }; needsDisplay = true } }
    var dockEdge: DockEdge? = .right { didSet { needsDisplay = true } }
    var hasDelivery = false {
        didSet {
            deliveryStartedAt = hasDelivery && !reduceMotion ? ProcessInfo.processInfo.systemUptime : nil
            deliveryProgress = deliveryStartedAt == nil ? 1 : 0
            if deliveryStartedAt != nil { startFrameTimerIfNeeded() }
            needsDisplay = true
        }
    }
    var origin = NSPoint.zero
    var down = NSPoint.zero
    private var hovering = false
    private var pressing = false
    private var reduceMotion = false
    private var hoverAmount: CGFloat = 0
    private var pressAmount: CGFloat = 0
    private var hoverTransition: PetScalarTransition?
    private var pressTransition: PetScalarTransition?
    private var contact: PetContact?
    private var dragPreviewContact: PetContact?
    private var dragPreviewSource: PetArtwork?
    private var dragPreviewTransition: PetScalarTransition?
    private var lastDragPreviewArtwork: PetArtwork?
    private var contactAmount: CGFloat = 0
    private var contactTransition: PetScalarTransition?
    private var dockTransition: PetDockTransition?
    private var dockSampleTime: TimeInterval?
    private var morphSource: PetArtwork?
    private var morphTargetFrame: NSRect?
    private var releaseStartedAt: TimeInterval?
    private var releaseProgress: CGFloat = 1
    private var blinkStartedAt: TimeInterval?
    private var blinkProgress: CGFloat = 1
    private var deliveryStartedAt: TimeInterval?
    private var deliveryProgress: CGFloat = 1
    private var gazeOffset: CGFloat = 0
    private var gazeTransition: PetScalarTransition?
    private var gazeVerticalOffset: CGFloat = 0
    private var gazeVerticalTransition: PetScalarTransition?
    private var gazeReturnTimer: Timer?
    private var lastGazeSample: PetGazeTrackingSample?
    private var globalPointerMonitor: Any?
    private var localPointerMonitor: Any?
    private var pointerVisibilityObserver: NSObjectProtocol?
    private var motionLifecycleEnabled = false
    private var inputLifecycleEnabled = false
    private var inputPanel: PetInputPanel?
    private var globalInputMonitor: Any?
    private var localInputMonitor: Any?
    private var inputObservers: [NSObjectProtocol] = []
    private var inputCursorRegion = NSRect.zero
    private var inputCursorDragging = false
    private var inputAccepting = false
    private var refreshingInput = false
    private var canceledPointerGesture = false
    private let pointerClicks = PetPointerClicks()
    private var dragStretch = CGVector.zero
    private var releaseDragStretch = CGVector.zero
    private var previousDragPoint = NSPoint.zero
    private var tracking: NSTrackingArea?
    private var frameTimer: Timer?
    private var blinkTimer: Timer?

    override var isOpaque: Bool { false }
    override func acceptsFirstMouse(for event: NSEvent?) -> Bool { true }
    override var acceptsFirstResponder: Bool { true }
    override func accessibilityValue() -> Any? {
        var state = dragging ? "表情：拖动中" : pressing ? "表情：按住" : "表情：跟随鼠标"
        guard CommandLine.arguments.contains("--pet-accessibility-qa") else { return state }
        if let owner = owner, owner.attachment != nil { state += "；悬挂：" + owner.attachmentSuspensionReason }
        return state + "；绘制进度：" + String(format: "%.3f", Double(heldExpressionAmount))
    }
    override func resetCursorRects() {
        let region = inputCursorRegion.intersection(bounds)
        if !region.isEmpty { addCursorRect(region, cursor: dragging ? .closedHand : .openHand) }
    }

    override func viewDidMoveToWindow() {
        super.viewDidMoveToWindow()
        window?.acceptsMouseMovedEvents = true
        if window == nil { stopAnimationTimers() }
        else { installInputMonitoring(); updateMotionPreferences() }
    }

    override func updateTrackingAreas() {
        super.updateTrackingAreas()
        if let tracking = tracking { removeTrackingArea(tracking) }
        let area = NSTrackingArea(rect: bounds, options: [.mouseEnteredAndExited, .mouseMoved, .activeAlways, .inVisibleRect], owner: self)
        addTrackingArea(area); tracking = area
    }

    deinit {
        frameTimer?.invalidate(); blinkTimer?.invalidate(); gazeReturnTimer?.invalidate()
        if let input = inputPanel { input.parent?.removeChildWindow(input); input.orderOut(nil) }
        if let monitor = globalPointerMonitor { NSEvent.removeMonitor(monitor) }
        if let monitor = localPointerMonitor { NSEvent.removeMonitor(monitor) }
        if let observer = pointerVisibilityObserver { NotificationCenter.default.removeObserver(observer) }
        if let monitor = globalInputMonitor { NSEvent.removeMonitor(monitor) }
        if let monitor = localInputMonitor { NSEvent.removeMonitor(monitor) }
        inputObservers.forEach { NotificationCenter.default.removeObserver($0) }
    }

    func stopAnimationTimers(includingInput: Bool = true) {
        motionLifecycleEnabled = false
        dragPreviewSource = nil; dragPreviewTransition = nil; lastDragPreviewArtwork = nil
        if includingInput { dragPreviewContact = nil }
        frameTimer?.invalidate(); frameTimer = nil
        blinkTimer?.invalidate(); blinkTimer = nil
        gazeReturnTimer?.invalidate(); gazeReturnTimer = nil
        gazeTransition = nil; gazeVerticalTransition = nil
        gazeOffset = 0; gazeVerticalOffset = 0; lastGazeSample = nil
        if let monitor = globalPointerMonitor { NSEvent.removeMonitor(monitor); globalPointerMonitor = nil }
        if let monitor = localPointerMonitor { NSEvent.removeMonitor(monitor); localPointerMonitor = nil }
        if let observer = pointerVisibilityObserver {
            NotificationCenter.default.removeObserver(observer); pointerVisibilityObserver = nil
        }
        if includingInput { stopInputMonitoring() }
    }

    func updateMotionPreferences() {
        guard window != nil, owner?.terminating != true else { return }
        installInputMonitoring()
        motionLifecycleEnabled = true
        reduceMotion = NSWorkspace.shared.accessibilityDisplayShouldReduceMotion
        if reduceMotion {
            stopAnimationTimers(includingInput: false)
            hoverTransition = nil; pressTransition = nil
            if let transition = dockTransition { window?.setFrame(transition.toFrame, display: true) }
            dockTransition = nil; contactTransition = nil; contactAmount = contact == nil ? 0 : 1
            morphSource = nil; morphTargetFrame = nil
            if dragging { contact = nil; contactAmount = 0 }
            releaseStartedAt = nil; blinkStartedAt = nil; deliveryStartedAt = nil
            hoverAmount = 0; pressAmount = 0
            releaseProgress = 1; blinkProgress = 1; deliveryProgress = 1
            dragStretch = .zero; releaseDragStretch = .zero
        } else {
            // Switching motion preferences while the mouse remains down must not lose its expression.
            if pressing || dragging { pressAmount = 1; pressTransition = nil }
            installPointerMonitors(); scheduleBlink()
        }
        refreshInputHit()
        if !reduceMotion { observePointer(at: NSEvent.mouseLocation) }
        needsDisplay = true
    }

    func dock(to placement: PetDockPlacement, animated: Bool = true) {
        guard let window = window else { return }
        let now = ProcessInfo.processInfo.systemUptime
        let current = window.frame
        let displayed = currentArtwork(frame: current, pose: currentPose())
        resetDragAdhesion()
        let velocity = dockTransition?.velocity(at: dockSampleTime ?? now) ?? .zero
        let previousContact = contact
        contact = placement.contact
        dockEdge = placement.contact.isWindow ? nil : placement.contact.edge
        contactTransition = nil
        let changesSurface = previousContact.map {
            $0.normal.dx != placement.contact.normal.dx || $0.normal.dy != placement.contact.normal.dy
        } ?? true
        let followsWindow = !animated && placement.contact.isWindow && previousContact != nil
        if !reduceMotion && owner?.attachmentSuspended != true && window.isVisible && (animated || followsWindow || dockTransition != nil) {
            morphSource = displayed; morphTargetFrame = placement.frame
            let duration: TimeInterval = animated ? 0.28 : changesSurface ? 0.18 : 0.07
            dockTransition = PetDockTransition(fromFrame: current, toFrame: placement.frame,
                startedAt: now, duration: duration, initialVelocity: velocity)
            dockSampleTime = now; contactAmount = 0
            startFrameTimerIfNeeded()
        } else {
            dockTransition = nil; dockSampleTime = nil; contactAmount = 1
            morphSource = nil; morphTargetFrame = nil
            window.setFrame(placement.frame, display: true)
        }
        needsDisplay = true
    }

    func pauseAttachmentPresentation() {
        if let transition = dockTransition { window?.setFrame(transition.toFrame, display: false) }
        dockTransition = nil; dockSampleTime = nil; contactTransition = nil
        contactAmount = contact == nil ? 0 : 1; morphSource = nil; morphTargetFrame = nil
        releaseStartedAt = nil; releaseProgress = 1; blinkStartedAt = nil; blinkProgress = 1
        dragStretch = .zero; releaseDragStretch = .zero
        stopAnimationTimers(includingInput: false)
        refreshInputHit()
        needsDisplay = true
    }

    private func releaseContactForDrag() {
        let displayed = currentArtwork(frame: window?.frame ?? .zero, pose: currentPose())
        resetDragAdhesion()
        dockTransition = nil; dockSampleTime = nil
        guard contact != nil || morphSource != nil else { return }
        contact = nil; morphTargetFrame = nil
        if reduceMotion { contactAmount = 0; contactTransition = nil; morphSource = nil }
        else {
            morphSource = displayed; contactAmount = 0
            contactTransition = PetScalarTransition(from: 0, to: 1,
                startedAt: ProcessInfo.processInfo.systemUptime, duration: 0.1)
            startFrameTimerIfNeeded()
        }
    }

    private func resetDragAdhesion() {
        dragPreviewContact = nil; dragPreviewSource = nil; dragPreviewTransition = nil; lastDragPreviewArtwork = nil
    }

    func previewDragAdhesion(at next: PetContact?) {
        guard let window = window, window.isVisible, inputLifecycleEnabled, !canceledPointerGesture,
              owner?.attachmentSuspended != true else { return }
        let next = dragging ? next : nil
        if next == nil && dragPreviewContact == nil { return }
        if let a = dragPreviewContact, let b = next, a.normal == b.normal,
           hypot(a.point.x - b.point.x, a.point.y - b.point.y) < 0.2 { return }
        let current = currentArtwork(frame: window.frame, pose: currentPose())
        // A fast exit can skip the proximity interval between events. Fade the last actually painted
        // bridges instead of recomputing an already-empty old contact and losing them in one frame.
        let displayed = current.adhesionAmount < 0.001 ? (lastDragPreviewArtwork ?? current) : current
        dragPreviewContact = next
        if reduceMotion { dragPreviewSource = nil; dragPreviewTransition = nil; needsDisplay = true; refreshInputHit(); return }
        dragPreviewSource = displayed
        dragPreviewTransition = PetScalarTransition(from: 0, to: 1,
            startedAt: ProcessInfo.processInfo.systemUptime, duration: next == nil ? 0.14 : 0.09)
        startFrameTimerIfNeeded(); needsDisplay = true
    }

    private func scheduleBlink() {
        guard motionLifecycleEnabled, !reduceMotion, window != nil, blinkTimer == nil else { return }
        let timer = Timer(timeInterval: TimeInterval.random(in: 4.5...8.5), repeats: false) { [weak self] _ in
            guard let self = self else { return }
            self.blinkTimer = nil
            if self.window?.isVisible == true && !self.dragging && !self.pressing && self.heldExpressionAmount <= 0.001 {
                self.blinkStartedAt = ProcessInfo.processInfo.systemUptime
                self.blinkProgress = 0
                self.startFrameTimerIfNeeded()
            }
            self.scheduleBlink()
        }
        blinkTimer = timer
        RunLoop.main.add(timer, forMode: .common)
    }

    private func startFrameTimerIfNeeded() {
        guard motionLifecycleEnabled, !reduceMotion, window != nil, frameTimer == nil else { return }
        let timer = Timer(timeInterval: 1.0 / 60.0, repeats: true) { [weak self] _ in self?.advanceMotion() }
        timer.tolerance = 0.001
        frameTimer = timer
        RunLoop.main.add(timer, forMode: .common)
    }

    private func advanceMotion() {
        let time = ProcessInfo.processInfo.systemUptime
        var active = false
        if let transition = dragPreviewTransition {
            if transition.value(at: time).complete { dragPreviewTransition = nil; dragPreviewSource = nil }
            else { active = true }
        }
        if let transition = gazeTransition {
            let value = transition.value(at: time); gazeOffset = value.amount
            if value.complete { gazeTransition = nil } else { active = true }
        }
        if let transition = gazeVerticalTransition {
            let value = transition.value(at: time); gazeVerticalOffset = value.amount
            if value.complete { gazeVerticalTransition = nil } else { active = true }
        }
        if let transition = dockTransition {
            let value = transition.value(at: time)
            window?.setFrame(value.frame, display: true); dockSampleTime = time
            // Keep an open conversation on the same presented frame as its companion.
            if owner?.chat?.isVisible == true { owner?.positionChat() }
            contactAmount = value.contact
            if value.complete {
                dockTransition = nil; morphSource = nil; morphTargetFrame = nil
                owner?.positionChat()
            } else { active = true }
        }
        if let transition = contactTransition {
            let value = transition.value(at: time); contactAmount = value.amount
            if value.complete { contactTransition = nil; morphSource = nil; morphTargetFrame = nil }
            else { active = true }
        }
        if let transition = hoverTransition {
            let value = transition.value(at: time); hoverAmount = value.amount
            if value.complete { hoverTransition = nil } else { active = true }
        }
        if let transition = pressTransition {
            let value = transition.value(at: time); pressAmount = value.amount
            if value.complete { pressTransition = nil } else { active = true }
        }
        if let startedAt = releaseStartedAt {
            releaseProgress = PetMotion.unit(CGFloat((time - startedAt) / 0.28))
            let decay = pow(1 - releaseProgress, 3)
            dragStretch = CGVector(dx: releaseDragStretch.dx * decay, dy: releaseDragStretch.dy * decay)
            if releaseProgress >= 1 { releaseStartedAt = nil; dragStretch = .zero } else { active = true }
        }
        if let startedAt = blinkStartedAt {
            blinkProgress = PetMotion.unit(CGFloat((time - startedAt) / 0.18))
            if blinkProgress >= 1 { blinkStartedAt = nil } else { active = true }
        }
        if let startedAt = deliveryStartedAt {
            deliveryProgress = PetMotion.unit(CGFloat((time - startedAt) / 0.65))
            if deliveryProgress >= 1 { deliveryStartedAt = nil } else { active = true }
        }
        refreshInputHit()
        refreshGazeForCurrentBody()
        needsDisplay = true
        if !active && hoverTransition == nil && pressTransition == nil && gazeTransition == nil && gazeVerticalTransition == nil {
            frameTimer?.invalidate(); frameTimer = nil
        }
    }

    func setHover(_ value: Bool) {
        guard hovering != value else { return }
        hovering = value
        guard !reduceMotion else { needsDisplay = true; return }
        let time = ProcessInfo.processInfo.systemUptime
        hoverAmount = hoverTransition?.value(at: time).amount ?? hoverAmount
        hoverTransition = PetScalarTransition(from: hoverAmount, to: value ? 1 : 0, startedAt: time, duration: 0.18)
        startFrameTimerIfNeeded()
    }

    private func setPress(_ value: Bool) {
        pressing = value
        refreshInputHit()
        if value { blinkStartedAt = nil; blinkProgress = 1; releaseStartedAt = nil; releaseProgress = 1 }
        guard !reduceMotion else { needsDisplay = true; return }
        let time = ProcessInfo.processInfo.systemUptime
        pressAmount = pressTransition?.value(at: time).amount ?? pressAmount
        pressTransition = PetScalarTransition(from: pressAmount, to: value ? 1 : 0, startedAt: time, duration: value ? 0.09 : 0.16)
        startFrameTimerIfNeeded()
    }

    private func installPointerMonitors() {
        guard motionLifecycleEnabled, !reduceMotion, window != nil else { return }
        // Mouse movement only: passive observation, no key events or permission prompts.
        if globalPointerMonitor == nil {
            globalPointerMonitor = NSEvent.addGlobalMonitorForEvents(matching: .mouseMoved) { [weak self] _ in
                self?.observePointer(at: NSEvent.mouseLocation)
            }
        }
        if localPointerMonitor == nil {
            localPointerMonitor = NSEvent.addLocalMonitorForEvents(matching: .mouseMoved) { [weak self] event in
                self?.observePointer(at: NSEvent.mouseLocation)
                return event
            }
        }
        if pointerVisibilityObserver == nil, let observedWindow = window {
            pointerVisibilityObserver = NotificationCenter.default.addObserver(
                forName: NSWindow.didChangeOcclusionStateNotification, object: observedWindow, queue: .main
            ) { [weak self] _ in
                guard let self = self else { return }
                if self.window?.isVisible != true || self.window?.occlusionState.contains(.visible) != true {
                    self.centerGaze(animated: false)
                } else { self.observePointer(at: NSEvent.mouseLocation) }
            }
        }
    }

    func setGazeTarget(_ target: CGFloat, vertical: CGFloat = 0, at time: TimeInterval, animated: Bool = true) {
        gazeOffset = gazeTransition?.value(at: time).amount ?? gazeOffset
        gazeVerticalOffset = gazeVerticalTransition?.value(at: time).amount ?? gazeVerticalOffset
        let target = PetGaze.clampedOffset(target), vertical = PetGaze.clampedVerticalOffset(vertical)
        guard motionLifecycleEnabled, !reduceMotion, animated else {
            gazeTransition = nil; gazeVerticalTransition = nil
            gazeOffset = 0; gazeVerticalOffset = 0; needsDisplay = true; return
        }
        let duration = target == 0 && vertical == 0 ? PetGaze.returnDuration : PetGaze.responseDuration
        func transition(from value: CGFloat, to target: CGFloat, previous: PetScalarTransition?) -> PetScalarTransition? {
            if abs(target - value) < 0.002 { return nil }
            if let previous = previous, previous.to == target, previous.duration == duration,
               !previous.value(at: time).complete { return previous }
            return PetScalarTransition(from: value, to: target, startedAt: time, duration: duration)
        }
        gazeTransition = transition(from: gazeOffset, to: target, previous: gazeTransition)
        gazeVerticalTransition = transition(from: gazeVerticalOffset, to: vertical, previous: gazeVerticalTransition)
        if gazeTransition == nil { gazeOffset = target }
        if gazeVerticalTransition == nil { gazeVerticalOffset = vertical }
        if gazeTransition != nil || gazeVerticalTransition != nil { startFrameTimerIfNeeded() }
        needsDisplay = true
    }

    private func centerGaze(animated: Bool) {
        gazeReturnTimer?.invalidate(); gazeReturnTimer = nil
        lastGazeSample = nil
        setGazeTarget(0, at: ProcessInfo.processInfo.systemUptime, animated: animated)
    }

    private func observePointer(at point: NSPoint) {
        guard motionLifecycleEnabled, !reduceMotion, let window = window,
              window.isVisible, !isHiddenOrHasHiddenAncestor, NSApp?.isHidden != true,
              let screen = window.screen ?? NSScreen.screens.first(where: { $0.frame.contains(NSPoint(x: window.frame.midX, y: window.frame.midY)) }) else {
            centerGaze(animated: false); return
        }
        _ = trackGazeContext(pointer: point, artwork: currentArtwork(frame: window.frame, pose: currentPose()),
            frame: window.frame, screen: screen.frame, at: ProcessInfo.processInfo.systemUptime)
    }

    func refreshGazeForCurrentBody() {
        guard let sample = lastGazeSample else { return }
        observePointer(at: sample.pointer)
    }

    @discardableResult
    func trackGazeContext(pointer: NSPoint, artwork: PetArtwork, frame: NSRect, screen: NSRect,
                          at time: TimeInterval) -> Bool {
        let authoredFace = CompanionResource.layout.faceCenter
        let displayedFace = artwork.labelPoint(authoredFace.x, authoredFace.y)
        let center = NSPoint(x: frame.minX + displayedFace.x, y: frame.minY + displayedFace.y)
        let reaches = PetGaze.localReaches(for: artwork)
        if !screen.contains(pointer) { centerGaze(animated: true); return false }
        let sample = PetGazeTrackingSample(pointer: pointer, face: center, reaches: reaches)
        if lastGazeSample == sample { return false }
        lastGazeSample = sample
        let target = PetGaze.target(pointer: pointer, center: center, screen: screen, reach: reaches.width)
        let vertical = PetGaze.targetVertical(pointer: pointer, center: center, screen: screen, reach: reaches.height)
        setGazeTarget(target, vertical: vertical, at: time)
        scheduleGazeReturn()
        return true
    }

    func scheduleGazeReturn() {
        gazeReturnTimer?.invalidate(); gazeReturnTimer = nil
        guard motionLifecycleEnabled, !reduceMotion, PetGaze.returnDelay > 0 else { return }
        let timer = Timer(timeInterval: PetGaze.returnDelay, repeats: false) { [weak self] _ in
            guard let self = self, self.motionLifecycleEnabled else { return }
            self.gazeReturnTimer = nil
            self.setGazeTarget(0, at: ProcessInfo.processInfo.systemUptime)
        }
        timer.tolerance = 0.05; gazeReturnTimer = timer
        RunLoop.main.add(timer, forMode: .common)
    }

    override func mouseEntered(with event: NSEvent) { refreshInputHit(); observePointer(at: NSEvent.mouseLocation) }
    override func mouseMoved(with event: NSEvent) { refreshInputHit(); observePointer(at: NSEvent.mouseLocation) }
    override func mouseExited(with event: NSEvent) { refreshInputHit() }

    private func installInputMonitoring() {
        guard window != nil, owner?.terminating != true else { return }
        inputLifecycleEnabled = true
        if inputObservers.isEmpty, let observedWindow = window {
            let center = NotificationCenter.default
            inputObservers.append(center.addObserver(forName: NSWindow.didChangeOcclusionStateNotification,
                object: observedWindow, queue: .main) { [weak self] _ in self?.refreshInputHit() })
            for name in [NSApplication.didHideNotification, NSApplication.didUnhideNotification, NSApplication.didResignActiveNotification] {
                inputObservers.append(center.addObserver(forName: name, object: nil, queue: .main) { [weak self] _ in self?.refreshInputHit() })
            }
        }
        refreshInputHit()
    }

    // Functional mouse routing stays independent of animated gaze and reduced-motion preferences.
    func installInputEventMonitors() {
        guard inputLifecycleEnabled, window != nil, owner?.terminating != true else { return }
        if globalInputMonitor == nil {
            globalInputMonitor = NSEvent.addGlobalMonitorForEvents(matching: .mouseMoved) { [weak self] _ in self?.refreshInputHit() }
        }
        if localInputMonitor == nil {
            localInputMonitor = NSEvent.addLocalMonitorForEvents(matching: .mouseMoved) { [weak self] event in
                self?.refreshInputHit(); return event
            }
        }
    }

    private func removeInputEventMonitors() {
        if let monitor = globalInputMonitor { NSEvent.removeMonitor(monitor); globalInputMonitor = nil }
        if let monitor = localInputMonitor { NSEvent.removeMonitor(monitor); localInputMonitor = nil }
    }

    private func hideInputPanel() {
        guard let input = inputPanel else { return }
        input.parent?.removeChildWindow(input); input.orderOut(nil)
    }

    private func syncInputPanel(to region: NSRect) {
        guard let parent = window, !region.isEmpty else { hideInputPanel(); return }
        if inputPanel == nil { inputPanel = PetInputPanel.make(region: region, target: self) }
        guard let input = inputPanel else { return }
        input.level = parent.level
        if input.frame != region { input.setFrame(region, display: false) }
        if input.parent !== parent { input.parent?.removeChildWindow(input); parent.addChildWindow(input, ordered: .above) }
        if !input.isVisible { input.orderFrontRegardless() }
        input.invalidateCursorRects(for: input.contentView!)
    }

    private func stopInputMonitoring() {
        inputLifecycleEnabled = false
        pointerClicks.cancel()
        resetDragAdhesion()
        hideInputPanel(); inputPanel?.close(); inputPanel = nil
        removeInputEventMonitors()
        inputObservers.forEach { NotificationCenter.default.removeObserver($0) }; inputObservers.removeAll()
        if pressing || dragging { canceledPointerGesture = true; owner?.cancelPetDragInputTracking() }
        pressing = false; dragging = false; hovering = false
        hoverAmount = 0; hoverTransition = nil; pressAmount = 0; pressTransition = nil
        inputAccepting = false; inputCursorRegion = .zero; inputCursorDragging = false
        window?.ignoresMouseEvents = true
        needsDisplay = true
    }

    func refreshInputHit(at pointer: NSPoint? = nil) {
        guard !refreshingInput else { return }
        refreshingInput = true; defer { refreshingInput = false }
        guard let window = window, inputLifecycleEnabled, owner?.terminating != true else {
            window?.ignoresMouseEvents = true; return
        }
        window.ignoresMouseEvents = true
        let visible = window.isVisible && window.alphaValue > 0.01 && !isHiddenOrHasHiddenAncestor
            && NSApp?.isHidden != true && owner?.attachmentSuspended != true
        guard visible else {
            pointerClicks.cancel()
            resetDragAdhesion()
            hideInputPanel()
            removeInputEventMonitors()
            if pressing || dragging { canceledPointerGesture = true; owner?.cancelPetDragInputTracking() }
            pressing = false; dragging = false; hovering = false
            pressAmount = 0; pressTransition = nil; hoverAmount = 0; hoverTransition = nil
            inputAccepting = false; inputCursorRegion = .zero; inputCursorDragging = false
            window.ignoresMouseEvents = true
            window.invalidateCursorRects(for: self)
            needsDisplay = true
            return
        }
        installInputEventMonitors()
        let frame = window.frame
        let presented = currentArtwork(frame: frame, pose: currentPose())
        let neutralPose = PetPose(translation: .zero, scale: NSSize(width: 1, height: 1), tilt: 0, eyeOpenness: 1)
        let neutral = currentArtwork(frame: frame, pose: neutralPose)
        let region = PetInputHitRegion.bounds(presented: presented, neutral: neutral, frame: frame)
        let localRegion = region.offsetBy(dx: -frame.minX, dy: -frame.minY).intersection(bounds)
        if localRegion != inputCursorRegion || inputCursorDragging != dragging {
            inputCursorRegion = localRegion; inputCursorDragging = dragging; window.invalidateCursorRects(for: self)
        }
        let point = pointer ?? NSEvent.mouseLocation
        let accepts = PetInputHitRegion.accepts(point, bounds: region, visible: true, enabled: true,
                                               pressing: pressing, dragging: dragging)
        inputAccepting = accepts
        syncInputPanel(to: region)
        // Keep hover tied to the true hit region even when the pointer leaves the small input window.
        if !pressing && !dragging { setHover(accepts) }
    }

    var inputLifecycleSnapshot: (enabled: Bool, monitorCount: Int, observerCount: Int,
                                 accepting: Bool, cursorRegion: NSRect, hoverStartedAt: TimeInterval?, canceledGesture: Bool, forcingCapture: Bool,
                                 proxyFrame: NSRect?, proxyVisible: Bool) {
        (inputLifecycleEnabled, (globalInputMonitor == nil ? 0 : 1) + (localInputMonitor == nil ? 0 : 1),
         inputObservers.count, inputAccepting, inputCursorRegion, hoverTransition?.startedAt, canceledPointerGesture, pressing || dragging,
         inputPanel?.frame, inputPanel?.isVisible == true)
    }

    var heldExpressionAmount: CGFloat {
        PetHeldExpression.amount(pressing: pressing, dragging: dragging, pressAmount: pressAmount, reducedMotion: reduceMotion)
    }

    var gazeBodySnapshot: PetArtwork {
        currentArtwork(frame: window?.frame ?? NSRect(origin: .zero, size: bounds.size), pose: currentPose())
    }

    var gazeLifecycleSnapshot: (monitorCount: Int, hasReturnTimer: Bool, hasFrameTimer: Bool,
                                hasBlinkTimer: Bool, hasVisibilityObserver: Bool, enabled: Bool, offset: CGFloat,
                                verticalOffset: CGFloat, horizontalMoving: Bool, verticalMoving: Bool,
                                horizontalDuration: TimeInterval?, verticalDuration: TimeInterval?,
                                horizontalTarget: CGFloat, verticalTarget: CGFloat, hasTrackingSample: Bool) {
        ((globalPointerMonitor == nil ? 0 : 1) + (localPointerMonitor == nil ? 0 : 1),
         gazeReturnTimer != nil, frameTimer != nil, blinkTimer != nil, pointerVisibilityObserver != nil,
         motionLifecycleEnabled, gazeOffset, gazeVerticalOffset, gazeTransition != nil, gazeVerticalTransition != nil,
         gazeTransition?.duration, gazeVerticalTransition?.duration,
         gazeTransition?.to ?? gazeOffset, gazeVerticalTransition?.to ?? gazeVerticalOffset, lastGazeSample != nil)
    }

    private func bodyPath(_ contour: PetContour) -> NSBezierPath {
        let path = NSBezierPath(); path.move(to: contour.start)
        for curve in contour.curves { path.curve(to: curve.end, controlPoint1: curve.first, controlPoint2: curve.second) }
        path.close(); return path
    }

    private func currentPose() -> PetPose {
        PetMotion.pose(edge: contact?.hoverEdge ?? dockEdge, hover: dragging ? 0 : hoverAmount,
                       press: pressAmount, drag: dragStretch, releaseProgress: releaseProgress,
                       blinkProgress: heldExpressionAmount > 0.001 || pressing || dragging ? 1 : blinkProgress,
                       reducedMotion: reduceMotion)
    }

    private func currentArtwork(frame: NSRect, pose: PetPose) -> PetArtwork {
        let target = PetMotion.artwork(contact: contact, frame: morphTargetFrame ?? frame, pose: pose)
        let base = morphSource.map { PetMotion.interpolate($0, target, amount: contactAmount) } ?? target
        let preview = PetDragAdhesion.preview(base: base, frame: frame, contact: dragPreviewContact)
        if let source = dragPreviewSource {
            let amount = dragPreviewTransition?.value(at: ProcessInfo.processInfo.systemUptime).amount ?? 1
            return base.adoptingAdhesion(PetMotion.interpolate(source, preview, amount: amount))
        }
        return preview
    }

    override func draw(_ dirtyRect: NSRect) {
        NSColor.clear.setFill(); bounds.fill()
        let pose = currentPose()
        let frame = window?.frame ?? NSRect(origin: .zero, size: bounds.size)
        let artwork = currentArtwork(frame: frame, pose: pose)
        if dragging || dragPreviewContact != nil || dragPreviewSource != nil { lastDragPreviewArtwork = artwork }
        let face = artwork.face
        if artwork.baseOpacity > 0.001 {
            NSColor(srgbRed: 0.73, green: 0.69, blue: 0.63, alpha: 0.26 * artwork.baseOpacity).setFill()
            bodyPath(artwork.contour).fill()
        }
        var transform = AffineTransform()
        transform.m11 = artwork.labelX.x - artwork.labelOrigin.x
        transform.m12 = artwork.labelX.y - artwork.labelOrigin.y
        transform.m21 = artwork.labelY.x - artwork.labelOrigin.x
        transform.m22 = artwork.labelY.y - artwork.labelOrigin.y
        transform.tX = artwork.labelOrigin.x; transform.tY = artwork.labelOrigin.y
        let layout = CompanionResource.layout
        // The shell retains its approved fillets, recessed panel, margins, line and stamp as one image.
        // Clip to the same source-pixel viewport used by the web avatar, including its shallow shadow.
        let clip = NSBezierPath(rect: layout.viewport.rect); clip.transform(using: transform)
        NSGraphicsContext.saveGraphicsState(); clip.addClip()
        if let graphics = NSGraphicsContext.current?.cgContext {
            graphics.concatenate(CGAffineTransform(a: transform.m11, b: transform.m12,
                c: transform.m21, d: transform.m22, tx: transform.tX, ty: transform.tY))
            // CGImage's row zero is its top; layout pixels also use top-left coordinates.
            graphics.translateBy(x: 0, y: layout.canvas.height)
            graphics.scaleBy(x: 1, y: -1)
            graphics.interpolationQuality = .high
            graphics.draw(CompanionResource.image,
                in: CGRect(x: 0, y: 0, width: layout.canvas.width, height: layout.canvas.height))
        }
        NSGraphicsContext.restoreGraphicsState()
        if artwork.adhesionAmount > 0.001, let graphics = NSGraphicsContext.current?.cgContext {
            let materialMask = PetFilletMaterial.rimBlendMask
            let affine = CGAffineTransform(a: transform.m11, b: transform.m12,
                c: transform.m21, d: transform.m22, tx: transform.tX, ty: transform.tY)
            NSGraphicsContext.saveGraphicsState()
            graphics.concatenate(affine)
            let flip = materialMask.rect.minY + materialMask.rect.maxY
            graphics.translateBy(x: 0, y: flip); graphics.scaleBy(x: 1, y: -1)
            graphics.clip(to: materialMask.rect, mask: materialMask.image)
            graphics.scaleBy(x: 1, y: -1); graphics.translateBy(x: 0, y: -flip)
            graphics.concatenate(affine.inverted())
            for (fillet, shade) in zip(artwork.fillets, artwork.filletShades) {
                let colors = shade.colors.map { $0.color(alpha: artwork.adhesionAmount) }
                NSGraphicsContext.saveGraphicsState(); bodyPath(fillet).addClip()
                NSGradient(colors: colors)?.draw(from: shade.start, to: shade.end,
                    options: [.drawsBeforeStartingLocation, .drawsAfterEndingLocation])
                NSGraphicsContext.restoreGraphicsState()
                if let outer = fillet.curves.first {
                    let shoulder = CGMutablePath(); shoulder.move(to: fillet.start)
                    shoulder.addCurve(to: outer.end, control1: outer.first, control2: outer.second)
                    for (width, strength): (CGFloat, CGFloat) in [(1.6, 0.10), (0.65, 0.20)] {
                        let sheen = shoulder.copy(strokingWithWidth: width, lineCap: .round, lineJoin: .round, miterLimit: 2)
                        NSGraphicsContext.saveGraphicsState(); bodyPath(fillet).addClip()
                        graphics.addPath(sheen); graphics.clip()
                        NSGradient(starting: NSColor(white: 0.6, alpha: 0),
                            ending: NSColor(white: 0.6, alpha: strength * artwork.adhesionAmount))?.draw(
                                from: shade.start, to: shade.end, options: [.drawsBeforeStartingLocation, .drawsAfterEndingLocation])
                        NSGraphicsContext.restoreGraphicsState()
                    }
                }
            }
            NSGraphicsContext.restoreGraphicsState()
        }
        let expression = heldExpressionAmount
        let offset = reduceMotion ? CGFloat(0) : gazeOffset * (1 - expression)
        let verticalOffset = reduceMotion ? CGFloat(0) : gazeVerticalOffset * (1 - expression)
        for index in layout.eyes.indices {
            let sourcePath = PetHeldExpression.eyeOutline(index: index, amount: expression,
                offset: offset, verticalOffset: verticalOffset, openness: pose.eyeOpenness)
            var eyeTransform = CGAffineTransform(a: transform.m11, b: transform.m12,
                c: transform.m21, d: transform.m22, tx: transform.tX, ty: transform.tY)
            let path = sourcePath.copy(using: &eyeTransform)!
            let eye = layout.eyes[index]
            let angle = eye.angle * .pi / 180
            let halfHeight = eye.height * max(CGFloat(0.1), PetMotion.unit(pose.eyeOpenness)) / 2
            let bottom = artwork.labelPoint(eye.cx + PetGaze.clampedOffset(offset) - sin(angle) * halfHeight,
                                           eye.cy + PetGaze.clampedVerticalOffset(verticalOffset) + cos(angle) * halfHeight)
            let top = artwork.labelPoint(eye.cx + PetGaze.clampedOffset(offset) + sin(angle) * halfHeight,
                                        eye.cy + PetGaze.clampedVerticalOffset(verticalOffset) - cos(angle) * halfHeight)
            let topColor = NSColor(srgbRed: 1, green: 248 / 255, blue: 235 / 255, alpha: 1)
            let bottomColor = NSColor(srgbRed: 241 / 255, green: 226 / 255, blue: 208 / 255, alpha: 1)
            NSGraphicsContext.saveGraphicsState()
            if let graphics = NSGraphicsContext.current?.cgContext {
                graphics.addPath(path); graphics.clip()
                NSGradient(starting: bottomColor, ending: topColor)?.draw(from: bottom, to: top,
                    options: [.drawsBeforeStartingLocation, .drawsAfterEndingLocation])
            }
            NSGraphicsContext.restoreGraphicsState()
        }

        if hasDelivery {
            let anchor = NSPoint(x: face.x + 10, y: face.y + 13)
            if deliveryProgress < 1 {
                let radius = 3.5 + deliveryProgress * 4
                let ring = NSBezierPath(ovalIn: NSRect(x: anchor.x - radius, y: anchor.y - radius, width: radius * 2, height: radius * 2))
                NSColor.systemBlue.withAlphaComponent((1 - deliveryProgress) * 0.3).setStroke(); ring.lineWidth = 0.8; ring.stroke()
            }
            NSColor(srgbRed: 0.08, green: 0.60, blue: 1, alpha: 1).setFill()
            NSBezierPath(ovalIn: NSRect(x: anchor.x - 3.2, y: anchor.y - 3.2, width: 6.4, height: 6.4)).fill()
        }
    }

    // Uses the production shell resource and dynamic-eye drawing without creating a window.
    func drawContactPreview(edge: DockEdge?, hover: CGFloat, delivery: Bool = false,
                            eyeOffset: CGFloat = 0, eyeVerticalOffset: CGFloat = 0, blink: CGFloat = 1,
                            isWindow: Bool = false, outward: Bool = false, held: Bool = false, dragged: Bool = false,
                            pressProgress: CGFloat? = nil, previewGap: CGFloat? = nil) {
        pressing = held || dragged; pressAmount = pressProgress ?? (pressing ? 1 : 0); dragging = dragged
        gazeVerticalOffset = PetGaze.clampedVerticalOffset(eyeVerticalOffset)
        gazeVerticalTransition = nil
        gazeOffset = min(max(eyeOffset, -PetGaze.maximumOffset), PetGaze.maximumOffset)
        gazeTransition = nil; blinkProgress = blink
        guard let edge = edge else {
            contact = nil; morphSource = nil; dockEdge = nil; hoverAmount = hover
            hasDelivery = delivery; deliveryProgress = 1; draw(bounds); return
        }
        let inward = PetDockGeometry.inward(edge)
        let normal = inward
        let distance = PetDockGeometry.standOff(normal: normal, isWindow: isWindow)
        contact = PetContact(point: NSPoint(x: 36 - normal.dx * distance, y: 43 - normal.dy * distance),
                             normal: normal, edge: edge, isWindow: isWindow)
        if let gap = previewGap, isWindow {
            contact = nil; morphSource = nil; dockEdge = nil
            let base = PetMotion.artwork(contact: nil, frame: .zero, pose: currentPose())
            let body = PetInputHitRegion.bodyBounds(base, in: .zero)
            let half = (abs(normal.dx) * body.width + abs(normal.dy) * body.height) / 2
            dragPreviewContact = PetContact(point: NSPoint(x: base.face.x - normal.dx * (half - 0.12 + gap),
                y: base.face.y - normal.dy * (half - 0.12 + gap)), normal: normal, edge: edge, isWindow: true)
        }
        contactAmount = 1; dockEdge = isWindow ? nil : edge; hoverAmount = hover; hovering = hover > 0
        reduceMotion = false; hasDelivery = delivery; deliveryProgress = 1
        draw(bounds)
    }

    override func mouseDown(with event: NSEvent) {
        canceledPointerGesture = false
        pointerClicks.begin(count: event.clickCount)
        owner?.cancelPendingPetDrop()
        down = NSEvent.mouseLocation; origin = window?.frame.origin ?? .zero
        previousDragPoint = down; dragging = false; dragStretch = .zero; releaseDragStretch = .zero
        setPress(true)
    }
    override func mouseDragged(with event: NSEvent) {
        guard !canceledPointerGesture else { return }
        let current = NSEvent.mouseLocation
        if hypot(current.x - down.x, current.y - down.y) < 5 && !dragging { return }
        if !dragging {
            pointerClicks.cancel()
            if dockTransition != nil, let window = window {
                origin = NSPoint(x: window.frame.minX - (current.x - down.x), y: window.frame.minY - (current.y - down.y))
            }
            releaseContactForDrag()
            owner?.beginPetDrag()
        }
        dragging = true
        if !reduceMotion {
            let direction = CGVector(dx: current.x - previousDragPoint.x, dy: current.y - previousDragPoint.y)
            let length = max(hypot(direction.dx, direction.dy), 1)
            let energy = min(max(hypot(current.x - previousDragPoint.x, current.y - previousDragPoint.y) / 10, 0.35), 1)
            dragStretch = CGVector(dx: dragStretch.dx * 0.45 + direction.dx / length * energy * 0.55,
                                   dy: dragStretch.dy * 0.45 + direction.dy / length * energy * 0.55)
        }
        previousDragPoint = current; needsDisplay = true
        window?.setFrameOrigin(NSPoint(x: origin.x + current.x - down.x, y: origin.y + current.y - down.y))
        observePointer(at: current)
        owner?.updateDragCandidate(at: current)
    }
    override func mouseUp(with event: NSEvent) {
        if canceledPointerGesture {
            pointerClicks.cancel()
            owner?.cancelPetDragInputTracking()
            canceledPointerGesture = false; dragging = false; setPress(false); refreshInputHit(); return
        }
        let wasDragging = dragging
        dragging = false; releaseDragStretch = dragStretch; setPress(false)
        if !reduceMotion { releaseStartedAt = ProcessInfo.processInfo.systemUptime; releaseProgress = 0; startFrameTimerIfNeeded() }
        else { dragStretch = .zero }
        if wasDragging {
            owner?.finishPetDrag(at: NSEvent.mouseLocation)
        } else {
            pointerClicks.finish(count: event.clickCount,
                single: { [weak self] in self?.owner?.toggleChat() },
                double: { owner?.openStage() })
        }
        refreshInputHit()
        needsDisplay = true
    }
    override func keyDown(with event: NSEvent) {
        if event.keyCode == 36 || event.keyCode == 49 { _ = accessibilityPerformPress() }
    }
    override func rightMouseDown(with event: NSEvent) {
        pointerClicks.cancel()
        owner?.showPetMenu(event: event, view: self)
    }
    override func accessibilityPerformPress() -> Bool {
        pointerClicks.cancel()
        owner?.toggleChat()
        return true
    }
}
final class CuratorApp: NSObject, NSApplicationDelegate, WKScriptMessageHandler, WKNavigationDelegate, WKUIDelegate, NSWindowDelegate, NSMenuItemValidation {
    var pet: PetPanel!
    var petView: PetView!
    var chat: ChatPanel?
    var chatWeb: WKWebView?
    var chatPageReady = false
    var pendingWorkspaceChats: [String: [String: Any]] = [:]
    var chatSurface: NSView?
    var chatGlass: NSVisualEffectView?
    private var chatDragView: ChatDragView?
    var chatWantsVisible = false
    var chatRestingFrame: NSRect?
    private var chatManualFrame: NSRect?
    private var chatDragInProgress = false
    var chatTransition: ChatTransition?
    var chatTransitionTimer: Timer?
    var stage: NSWindow?
    var stageWeb: WKWebView?
    var stageReady = false
    private let personalMode = ProcessInfo.processInfo.arguments.contains("--personal")
    private var demoTagSignedIn = false
    private var desktopTagAvailable: Bool { personalMode || demoTagSignedIn }
    private let stageMinimumSize = NSSize(width: 720, height: 520)
    private let loginWindowSize = NSSize(width: 420, height: 500)
    private let stageBackground = NSColor(srgbRed: 34.0 / 255.0, green: 35.0 / 255.0, blue: 38.0 / 255.0, alpha: 1)
    private var stageUsesLoginLayout = false
    private var stageWorkspaceFrame: NSRect?
    private var stageLoginAfterFullScreenExit = false
    var pendingExhibitionID: String?
    var pendingCollectionID: String?
    var pendingConversationURL: URL?
    var statusItem: NSStatusItem!
    private var attachmentStatusItem: NSMenuItem?
    var backend: Process?
    var backendReadHandle: FileHandle?
    var backendOutput = Data()
    var backendURL: URL?
    var attachment: AttachedWindow?
    var attachmentDockAnchor: PetWindowAnchor?
    var attachmentTimer: Timer?
    var attachmentSuspended = false
    var attachmentSuspensionReason = "none"
    var attachmentVisibilityTransition: PetScalarTransition?
    var attachmentVisibilityTimer: Timer?
    // Only followProbeQueue accesses this metadata cache/evidence.
    var followSceneCache: PetWindowScene?
    private var missingWindow: (token: UUID, since: TimeInterval)?
    var candidatePanel: NSPanel?
    var candidateToken: String?
    var lastCandidateCheck: TimeInterval = 0
    var dragGeneration: UInt64 = 0
    var pendingDropGeneration: UInt64?
    var isPetDragActive = false
    var dragTimer: Timer?
    var dragProbeTicket: UUID?
    var dragWindows: [AttachedWindow] = []
    var candidateTransition: ChatTransition?
    var candidateTransitionTimer: Timer?
    var followProbeTicket: UUID?
    var followCompletions: [() -> Void] = []
    var attachmentPlacementNormal: CGVector?
    let dragProbeQueue = DispatchQueue(label: "forme.window-drag-probe", qos: .userInteractive)
    let followProbeQueue = DispatchQueue(label: "forme.window-follow-probe", qos: .userInitiated)
    var noticePanel: NSPanel?
    var noticeTimer: Timer?
    var lastWindowDiagnostic = "这里没有找到可附着的窗口，请拖到文章内容或标题栏上。"
    var context: [String: Any] = [:]
    var attentionReadTicket: UUID?
    var lastAttentionRead: TimeInterval = 0
    var lastKnownPageKey: String?
    private var browserPageToReveal: BrowserPageRevealTarget?
    var contextVersion: UInt64 = 0
    var lastExternalApplication: NSRunningApplication?
    var terminating = false
    var started = false
    let captureQueue = DispatchQueue(label: "forme.browser-capture", qos: .userInitiated)

    func applicationDidFinishLaunching(_ notification: Notification) {
        NSApp.setActivationPolicy(.accessory)
        if let frontmost = NSWorkspace.shared.frontmostApplication, frontmost.processIdentifier != getpid() { lastExternalApplication = frontmost }
        NSWorkspace.shared.notificationCenter.addObserver(self, selector: #selector(externalApplicationActivated(_:)),
            name: NSWorkspace.didActivateApplicationNotification, object: nil)
        createStatusItem()
        if personalMode { createPet() }
        NSWorkspace.shared.notificationCenter.addObserver(self, selector: #selector(accessibilityDisplayOptionsChanged(_:)),
            name: NSWorkspace.accessibilityDisplayOptionsDidChangeNotification, object: nil)
        startBackend()
    }

    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool { false }
    func applicationDidChangeScreenParameters(_ notification: Notification) {
        if pet != nil { positionChat() }
    }

    func applicationWillTerminate(_ notification: Notification) {
        terminating = true; attachmentTimer?.invalidate(); noticeTimer?.invalidate(); chatTransitionTimer?.invalidate()
        attachmentVisibilityTimer?.invalidate(); attachmentVisibilityTimer = nil; attachmentVisibilityTransition = nil
        dragGeneration &+= 1; dragTimer?.invalidate(); candidateTransitionTimer?.invalidate()
        dragProbeTicket = nil; followProbeTicket = nil; followCompletions.removeAll()
        petView?.stopAnimationTimers()
        NSWorkspace.shared.notificationCenter.removeObserver(self)
        candidatePanel?.orderOut(nil); noticePanel?.orderOut(nil)
        backendReadHandle?.readabilityHandler = nil
        try? backendReadHandle?.close()
        if let process = backend, process.isRunning {
            process.terminate()
            let deadline = Date().addingTimeInterval(1.5)
            while process.isRunning && Date() < deadline { Thread.sleep(forTimeInterval: 0.05) }
            if process.isRunning { Darwin.kill(process.processIdentifier, SIGKILL) }
            process.waitUntilExit()
        }
    }

    func createStatusItem() {
        let main = NSMenu()
        let appItem = NSMenuItem(); main.addItem(appItem)
        let appMenu = NSMenu(title: "Folio")
        let quitItem = NSMenuItem(title: "退出 Folio", action: #selector(quit), keyEquivalent: "q"); quitItem.target = self
        appMenu.addItem(quitItem); appItem.submenu = appMenu
        let editItem = NSMenuItem(title: "编辑", action: nil, keyEquivalent: ""); main.addItem(editItem)
        let editMenu = NSMenu(title: "编辑")
        editMenu.addItem(withTitle: "撤销", action: Selector(("undo:")), keyEquivalent: "z")
        editMenu.addItem(.separator())
        editMenu.addItem(withTitle: "剪切", action: #selector(NSText.cut(_:)), keyEquivalent: "x")
        editMenu.addItem(withTitle: "复制", action: #selector(NSText.copy(_:)), keyEquivalent: "c")
        editMenu.addItem(withTitle: "粘贴", action: #selector(NSText.paste(_:)), keyEquivalent: "v")
        editMenu.addItem(withTitle: "全选", action: #selector(NSText.selectAll(_:)), keyEquivalent: "a")
        editItem.submenu = editMenu
        NSApp.mainMenu = main
        statusItem = NSStatusBar.system.statusItem(withLength: NSStatusItem.variableLength)
        statusItem.button?.title = "Folio"
        statusItem.button?.toolTip = "Folio · Tag"
        let menu = NSMenu()
        let attachmentStatus = NSMenuItem(title: AttachmentMenuLabel.title(for: attachment, context: context), action: nil, keyEquivalent: "")
        attachmentStatus.isEnabled = false
        attachmentStatusItem = attachmentStatus
        menu.addItem(attachmentStatus)
        menu.addItem(withTitle: "打开正在关注的页面", action: #selector(openFocusedPage), keyEquivalent: "")
        menu.addItem(.separator())
        menu.addItem(withTitle: "打开私人收藏馆", action: #selector(openStage), keyEquivalent: "")
        menu.addItem(withTitle: "和 Tag 聊聊", action: #selector(showChat), keyEquivalent: "")
        menu.addItem(withTitle: "关注当前浏览器页面", action: #selector(attachCurrentBrowser), keyEquivalent: "")
        let dockItem = NSMenuItem(title: "回到屏幕边缘", action: nil, keyEquivalent: "")
        let dockMenu = NSMenu(title: "回到屏幕边缘")
        let nearest = dockMenu.addItem(withTitle: "就近吸附", action: #selector(detachToEdge), keyEquivalent: "")
        nearest.target = self
        for (title, edge) in [("上边", DockEdge.top), ("右边", .right), ("下边", .bottom), ("左边", .left)] {
            let item = dockMenu.addItem(withTitle: title, action: #selector(dockToScreenEdge(_:)), keyEquivalent: "")
            item.target = self; item.representedObject = edge.rawValue
        }
        dockItem.submenu = dockMenu; menu.addItem(dockItem)
        menu.addItem(withTitle: "开启窗口识别…", action: #selector(enableWindowRecognition), keyEquivalent: "")
        menu.addItem(.separator())
        menu.addItem(withTitle: "关于 Folio", action: #selector(showAbout), keyEquivalent: "")
        menu.addItem(withTitle: "退出 Folio", action: #selector(quit), keyEquivalent: "q")
        for item in menu.items { item.target = self }
        statusItem.menu = menu
    }

    func validateMenuItem(_ menuItem: NSMenuItem) -> Bool {
        if menuItem.action == #selector(openFocusedPage) { return attachment != nil }
        switch menuItem.action {
        case #selector(showChat), #selector(attachCurrentBrowser), #selector(detachToEdge),
             #selector(dockToScreenEdge(_:)), #selector(enableWindowRecognition): return desktopTagAvailable
        default: return true
        }
    }

    func createPet() {
        // Prepare all source-sampled edge materials before the first interactive drag.
        _ = PetFilletMaterial.colors(normal: CGVector(dx: 1, dy: 0), index: 0)
        _ = PetFilletMaterial.rimBlendMask
        pet = PetPanel(contentRect: NSRect(x: 0, y: 0, width: 72, height: 84), styleMask: [.borderless, .nonactivatingPanel], backing: .buffered, defer: false)
        pet.title = "Folio · Tag"; pet.isOpaque = false; pet.backgroundColor = .clear
        pet.identifier = NSUserInterfaceItemIdentifier("forme.pet.window")
        pet.setAccessibilityIdentifier("forme.pet.window")
        pet.hasShadow = false; pet.level = .floating; pet.ignoresMouseEvents = true
        pet.hidesOnDeactivate = false
        pet.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary]
        pet.isReleasedWhenClosed = false
        petView = PetView(frame: NSRect(x: 0, y: 0, width: 72, height: 84)); petView.owner = self
        petView.setAccessibilityElement(true); petView.setAccessibilityRole(.button)
        petView.setAccessibilityIdentifier("forme.pet.control")
        petView.setAccessibilityLabel("Tag，Folio 的小展签伙伴。单击展开或收起聊天，双击打开 Folio 主窗口。拖到窗口上可关联页面。")
        petView.toolTip = "单击展开或收起聊天，双击打开 Folio 主窗口。拖到文章窗口可关联页面，右键查看更多"
        pet.contentView = petView
        let screen = NSScreen.main?.visibleFrame ?? NSRect(x: 0, y: 0, width: 1200, height: 800)
        petView.dock(to: PetDockGeometry.screen(edge: .right, near: NSPoint(x: screen.maxX, y: screen.midY), in: screen), animated: false)
        pet.orderFrontRegardless()
    }

    private func setDemoTagSignedIn(_ signedIn: Bool) {
        guard !personalMode, demoTagSignedIn != signedIn else { return }
        demoTagSignedIn = signedIn

        if signedIn {
            if let pet = pet {
                pet.allowsPresentation = true
                restoreStandalonePresentation()
            } else { createPet() }
            let greeting = "你好，我是 Tag。"
            showPetNotice(greeting, duration: 5)
            NSAccessibility.post(element: petView as Any, notification: .announcementRequested,
                                 userInfo: [.announcement: greeting, .priority: NSAccessibilityPriorityLevel.medium.rawValue])
            return
        }

        // Disallow reordering even if an attachment callback was already in flight.
        pet.allowsPresentation = false
        pet.orderOut(nil)
        detachToScreenEdge(nil)
        petView.stopAnimationTimers()
        setChatVisible(false, animated: false)
        chatWeb?.stopLoading()
        chatWeb?.configuration.userContentController.removeScriptMessageHandler(forName: "forme")
        chat?.close()
        chat = nil; chatWeb = nil; chatSurface = nil; chatGlass = nil; chatDragView = nil
        chatPageReady = false; chatRestingFrame = nil
        pendingWorkspaceChats.removeAll(); pendingConversationURL = nil
    }

    func startBackend() {
        guard let root = Bundle.main.object(forInfoDictionaryKey: "FORMEProjectRoot") as? String,
              let node = Bundle.main.object(forInfoDictionaryKey: "FORMENodePath") as? String,
              FileManager.default.isExecutableFile(atPath: node) else {
            showFailure("暂时找不到本机运行环境。请重新打开应用；如果仍无法启动，请联系维护者重新准备这个本机版本。")
            return
        }
        let process = Process(); process.executableURL = URL(fileURLWithPath: node)
        process.arguments = ["--env-file-if-exists=\(root)/.env", "\(root)/desktop/server/index.mjs"] + (personalMode ? ["--personal"] : [])
        process.currentDirectoryURL = URL(fileURLWithPath: root)
        var environment = ProcessInfo.processInfo.environment
        environment["FORME_DESKTOP_DATA_DIR"] = "\(root)/.data/desktop"
        environment["FORME_DESKTOP_PORT"] = "0"
        process.environment = environment
        let output = Pipe(); process.standardOutput = output
        backendReadHandle = output.fileHandleForReading
        process.standardError = FileHandle.standardError
        output.fileHandleForReading.readabilityHandler = { [weak self] handle in
            let bytes = handle.availableData
            guard !bytes.isEmpty else { handle.readabilityHandler = nil; return }
            DispatchQueue.main.async {
                guard let self = self else { return }
                self.backendOutput.append(bytes)
                while let range = self.backendOutput.range(of: Data([10])) {
                    let line = String(data: self.backendOutput.subdata(in: 0..<range.lowerBound), encoding: .utf8) ?? ""
                    self.backendOutput.removeSubrange(0...range.lowerBound)
                    let prefix = "FORME_DESKTOP_READY "
                    if line.hasPrefix(prefix), let url = URL(string: String(line.dropFirst(prefix.count))), url.host == "127.0.0.1", !self.started {
                        self.started = true; self.backendURL = url
                        if self.personalMode { self.showChat() } else { self.showStage() }
                    }
                    let eventPrefix = "FORME_DESKTOP_EVENT "
                    if line.hasPrefix(eventPrefix),
                       let data = String(line.dropFirst(eventPrefix.count)).data(using: .utf8),
                       let event = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any],
                       event["type"] as? String == "exhibition-ready", self.desktopTagAvailable {
                        self.petView.hasDelivery = true; self.petView.needsDisplay = true
                        self.petView.toolTip = "有一场小展整理好了。点我，有空一起看看。"
                    }
                }
            }
        }
        process.terminationHandler = { [weak self] _ in
            DispatchQueue.main.async {
                guard let self = self, !self.terminating else { return }
                self.setDemoTagSignedIn(false)
                self.showFailure("本机整理服务已停止。收藏仍保存在这台电脑，重新打开应用后可继续。")
            }
        }
        do { try process.run(); backend = process }
        catch { showFailure("本机整理服务暂时没有启动。请重新打开应用后再试。") }
    }

    func surfaceURL(_ surface: String) -> URL? {
        guard let base = backendURL else { return nil }
        let path = surface == "stage" ? "prototype/immersive-exhibition/light.html" : "curator/"
        var parts = URLComponents(url: base.appendingPathComponent(path), resolvingAgainstBaseURL: false)!
        if surface != "stage" { parts.queryItems = [URLQueryItem(name: "surface", value: surface)] }
        return parts.url
    }

    func webView(surface: String) -> WKWebView? {
        guard let url = surfaceURL(surface) else { return nil }
        let content = WKUserContentController(); content.add(self, name: "forme")
        if surface == "chat" {
            content.addUserScript(WKUserScript(source: ChatDragView.regionScript, injectionTime: .atDocumentEnd, forMainFrameOnly: true))
        }
        let configuration = WKWebViewConfiguration(); configuration.userContentController = content
        let view = WKWebView(frame: .zero, configuration: configuration)
        view.navigationDelegate = self
        view.uiDelegate = self
        view.identifier = NSUserInterfaceItemIdentifier("forme.\(surface).web")
        view.setAccessibilityIdentifier("forme.\(surface).web")
        view.setValue(false, forKey: "drawsBackground")
        view.underPageBackgroundColor = .clear
        view.load(URLRequest(url: url))
        return view
    }

    @objc func showChat() { presentChat(activate: true) }

    private func presentChat(activate: Bool) {
        guard backendURL != nil, desktopTagAvailable else { return }
        petView.hasDelivery = false; petView.needsDisplay = true
        if chat == nil {
            let panel = ChatPanel(contentRect: NSRect(x: 0, y: 0, width: 390, height: 570), styleMask: [.borderless], backing: .buffered, defer: false)
            panel.title = "Folio · 和 Tag 聊聊"; panel.isReleasedWhenClosed = false; panel.level = .floating
            panel.appearance = NSAppearance(named: .darkAqua)
            panel.identifier = NSUserInterfaceItemIdentifier("forme.chat.window")
            panel.setAccessibilityIdentifier("forme.chat.window")
            panel.animationBehavior = .none
            panel.hidesOnDeactivate = false
            panel.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary]
            panel.isOpaque = false; panel.backgroundColor = .clear; panel.hasShadow = true
            guard let view = webView(surface: "chat") else { return }
            let surface = NSView(frame: NSRect(x: 0, y: 0, width: 390, height: 570))
            surface.wantsLayer = true; surface.layer?.cornerRadius = 16; surface.layer?.masksToBounds = true
            let glass = NSVisualEffectView(frame: surface.bounds)
            glass.material = .hudWindow; glass.blendingMode = .behindWindow; glass.state = .active
            glass.appearance = NSAppearance(named: .darkAqua)
            glass.autoresizingMask = [.width, .height]
            view.frame = surface.bounds; view.autoresizingMask = [.width, .height]
            let dragView = ChatDragView(frame: .zero)
            dragView.owner = self
            dragView.isHidden = true
            dragView.setAccessibilityElement(false); dragView.setAccessibilityHidden(true)
            surface.addSubview(glass); surface.addSubview(view); surface.addSubview(dragView); panel.contentView = surface
            chatSurface = surface; chatGlass = glass; chatWeb = view; chat = panel; chatDragView = dragView
            updateAccessibilityAppearance()
        }
        positionChat()
        setChatVisible(true)
        if activate {
            NSApp.activate(ignoringOtherApps: true); chat?.makeKeyAndOrderFront(nil)
            focusChatComposer()
        }
        refreshAttentionContextIfNeeded(force: true)
        sendContext(); chatWeb?.evaluateJavaScript("window.formeNative?.refresh?.()", completionHandler: nil)
    }

    func toggleChat() {
        if chatWantsVisible { setChatVisible(false) } else { showChat() }
    }

    func positionChat() {
        guard let panel = chat, !chatDragInProgress else { return }
        let resting: NSRect
        if let manual = chatManualFrame {
            let screen = screenAt(NSPoint(x: manual.midX, y: manual.midY)).visibleFrame
            resting = Docking.constrainedChatFrame(manual, in: screen)
            chatManualFrame = resting
        } else {
            let screen = screenAt(NSPoint(x: pet.frame.midX, y: pet.frame.midY)).visibleFrame
            resting = Docking.chatFrame(near: pet.frame, screen: screen, size: NSSize(width: 390, height: 570))
        }
        guard chatRestingFrame != resting else { return }
        if let previous = chatRestingFrame, var transition = chatTransition {
            let dx = resting.minX - previous.minX, dy = resting.minY - previous.minY
            func moved(_ frame: NSRect) -> NSRect {
                NSRect(x: frame.minX + dx, y: frame.minY + dy, width: resting.width, height: resting.height)
            }
            transition.fromFrame = moved(transition.fromFrame)
            transition.toFrame = moved(transition.toFrame)
            chatTransition = transition
            panel.setFrame(moved(panel.frame), display: true)
        } else {
            panel.setFrame(resting, display: true)
        }
        chatRestingFrame = resting
    }

    func beginChatDrag() -> Bool {
        guard let panel = chat, panel.isVisible, chatWantsVisible else { return false }
        chatDragInProgress = true
        chatTransitionTimer?.invalidate(); chatTransitionTimer = nil; chatTransition = nil
        panel.alphaValue = 1
        return true
    }

    func moveChatDrag(to proposed: NSRect, cursor: NSPoint) {
        guard let panel = chat, chatDragInProgress else { return }
        let resting = Docking.constrainedChatFrame(proposed, in: screenAt(cursor).visibleFrame)
        chatManualFrame = resting
        chatRestingFrame = resting
        if panel.frame != resting { panel.setFrame(resting, display: true) }
    }

    func endChatDrag() { chatDragInProgress = false }

    func setChatVisible(_ visible: Bool, animated: Bool = true) {
        guard let panel = chat else { return }
        if visible == chatWantsVisible, chatTransition == nil, panel.isVisible == visible { return }
        // Every reversal starts at the actual displayed state, never an old target.
        chatTransitionTimer?.invalidate(); chatTransitionTimer = nil; chatTransition = nil
        chatWantsVisible = visible
        if !visible { endChatDrag() }
        chatWeb?.evaluateJavaScript("window.formeNative?.setVisible?.(\(visible ? "true" : "false"))", completionHandler: nil)
        let resting = chatRestingFrame ?? panel.frame
        let tucked = resting.offsetBy(dx: 0, dy: -8)
        if visible && !panel.isVisible {
            panel.alphaValue = 0
            panel.setFrame(tucked, display: false)
            panel.orderFront(nil)
        }
        let motion = ChatTransition(fromFrame: panel.frame, toFrame: visible ? resting : tucked,
                                    fromAlpha: panel.alphaValue, toAlpha: visible ? 1 : 0,
                                    startedAt: ProcessInfo.processInfo.systemUptime, duration: 0.2, showing: visible)
        chatTransition = motion
        if !animated || NSWorkspace.shared.accessibilityDisplayShouldReduceMotion {
            advanceChatTransition(at: motion.startedAt + motion.duration)
            return
        }
        let timer = Timer(timeInterval: 1.0 / 60.0, repeats: true) { [weak self] _ in
            self?.advanceChatTransition()
        }
        timer.tolerance = 0.001
        chatTransitionTimer = timer
        RunLoop.main.add(timer, forMode: .common)
    }

    func advanceChatTransition(at time: TimeInterval = ProcessInfo.processInfo.systemUptime) {
        guard let panel = chat, let transition = chatTransition else { return }
        let value = transition.value(at: time)
        panel.setFrame(value.frame, display: true)
        panel.alphaValue = value.alpha
        if value.complete {
            chatTransitionTimer?.invalidate(); chatTransitionTimer = nil; chatTransition = nil
            if !transition.showing { panel.orderOut(nil) }
            else { focusChatComposer() }
        }
    }

    func focusChatComposer() {
        guard chatWantsVisible, let panel = chat, panel.isVisible, panel.isKeyWindow,
              let view = chatWeb, !view.isLoading else { return }
        panel.makeFirstResponder(view)
        view.evaluateJavaScript("window.formeNative?.focusComposer?.()", completionHandler: nil)
    }

    @objc func accessibilityDisplayOptionsChanged(_ notification: Notification) {
        if Thread.isMainThread { updateAccessibilityAppearance() }
        else { DispatchQueue.main.async { [weak self] in self?.updateAccessibilityAppearance() } }
    }

    func updateAccessibilityAppearance() {
        let workspace = NSWorkspace.shared
        if desktopTagAvailable && !attachmentSuspended { petView?.updateMotionPreferences() }
        if workspace.accessibilityDisplayShouldReduceMotion, let transition = attachmentVisibilityTransition {
            advanceAttachmentVisibility(at: transition.startedAt + transition.duration)
        }
        if NSWorkspace.shared.accessibilityDisplayShouldReduceMotion,
           let transition = candidateTransition {
            candidateTransition = nil; candidateTransitionTimer?.invalidate(); candidateTransitionTimer = nil
            candidatePanel?.setFrame(transition.toFrame, display: true)
            candidatePanel?.alphaValue = transition.toAlpha
            if transition.toAlpha == 0 { candidatePanel?.orderOut(nil) }
        }
        let reduceTransparency = workspace.accessibilityDisplayShouldReduceTransparency
        let graphite = NSColor(srgbRed: 27.0 / 255.0, green: 29.0 / 255.0, blue: 32.0 / 255.0, alpha: 1)
        let surfaceColor = reduceTransparency ? graphite : NSColor.clear
        chatGlass?.isHidden = reduceTransparency
        chatSurface?.layer?.backgroundColor = surfaceColor.cgColor
        if workspace.accessibilityDisplayShouldReduceMotion, let transition = chatTransition {
            advanceChatTransition(at: transition.startedAt + transition.duration)
        }
        let reduceMotion = workspace.accessibilityDisplayShouldReduceMotion
        for view in [chatWeb, stageWeb].compactMap({ $0 }) {
            view.evaluateJavaScript("document.documentElement.setAttribute('data-reduce-transparency', '\(reduceTransparency)'); document.documentElement.setAttribute('data-reduce-motion', '\(reduceMotion)')", completionHandler: nil)
        }
    }

    @objc func openStage() {
        showStage()
    }

    private func setStageLoginLayout(_ login: Bool) {
        guard let window = stage else { return }
        if login && window.styleMask.contains(.fullScreen) {
            guard !stageLoginAfterFullScreenExit else { return }
            stageLoginAfterFullScreenExit = true
            window.toggleFullScreen(nil)
            return
        }
        stageLoginAfterFullScreenExit = false
        guard stageUsesLoginLayout != login else { return }
        stageUsesLoginLayout = login

        if login {
            stageWorkspaceFrame = window.frame
            let screen = window.screen?.visibleFrame ?? NSScreen.main?.visibleFrame ?? window.frame
            let size = NSSize(width: min(loginWindowSize.width, screen.width), height: min(loginWindowSize.height, screen.height))
            let frame = NSRect(x: screen.midX - size.width / 2, y: screen.midY - size.height / 2, width: size.width, height: size.height)
            window.minSize = size
            window.styleMask.remove(.resizable)
            window.appearance = NSAppearance(named: .darkAqua)
            window.backgroundColor = NSColor(srgbRed: 25.0 / 255.0, green: 26.0 / 255.0, blue: 28.0 / 255.0, alpha: 1)
            window.title = "登录 Folio"
            window.setFrame(frame, display: true)
        } else {
            window.styleMask.insert(.resizable)
            window.appearance = NSAppearance(named: .darkAqua)
            window.backgroundColor = stageBackground
            window.minSize = stageMinimumSize
            if let frame = stageWorkspaceFrame {
                window.setFrame(window.constrainFrameRect(frame, to: window.screen), display: true)
            }
            stageWorkspaceFrame = nil
        }
    }

    func windowDidExitFullScreen(_ notification: Notification) {
        guard let window = notification.object as? NSWindow, window === stage, stageLoginAfterFullScreenExit else { return }
        setStageLoginLayout(true)
    }

    func showStage(keepChatVisible: Bool = false) {
        guard backendURL != nil else { return }
        if stage == nil {
            let screen = NSScreen.main?.visibleFrame ?? NSRect(x: 0, y: 0, width: 1200, height: 800)
            let rect = NSRect(x: 0, y: 0, width: min(1120, screen.width - 64), height: min(780, screen.height - 64))
            let window = NSWindow(contentRect: rect,
                                  styleMask: [.titled, .closable, .miniaturizable, .resizable, .fullSizeContentView],
                                  backing: .buffered, defer: false)
            window.title = "Folio · 私人收藏馆"; window.isReleasedWhenClosed = false
            window.appearance = NSAppearance(named: .darkAqua)
            window.titleVisibility = .hidden
            window.titlebarAppearsTransparent = true
            window.titlebarSeparatorStyle = .none
            window.isMovableByWindowBackground = true
            window.backgroundColor = stageBackground
            window.identifier = NSUserInterfaceItemIdentifier("forme.stage.window")
            window.setAccessibilityIdentifier("forme.stage.window")
            window.animationBehavior = .documentWindow
            window.minSize = stageMinimumSize; window.delegate = self
            if let view = webView(surface: "stage"), let surface = window.contentView {
                view.translatesAutoresizingMaskIntoConstraints = false
                surface.addSubview(view)
                NSLayoutConstraint.activate([
                    view.leadingAnchor.constraint(equalTo: surface.leadingAnchor),
                    view.trailingAnchor.constraint(equalTo: surface.trailingAnchor),
                    view.bottomAnchor.constraint(equalTo: surface.bottomAnchor),
                    NSLayoutConstraint(item: view, attribute: .top, relatedBy: .equal,
                                       toItem: window.contentLayoutGuide ?? surface, attribute: .top, multiplier: 1, constant: 0),
                ])
                stageWeb = view
            }
            window.center(); stage = window
            if !personalMode { setStageLoginLayout(true) }
            updateAccessibilityAppearance()
        } else {
            let showingSample = URLComponents(url: stageWeb?.url ?? backendURL!, resolvingAgainstBaseURL: false)?.queryItems?.contains(where: { $0.name == "sample" && $0.value == "1" }) == true
            let showingConversation = URLComponents(url: stageWeb?.url ?? backendURL!, resolvingAgainstBaseURL: false)?.queryItems?.contains(where: { $0.name == "surface" && $0.value == "workspace-chat" }) == true
            if showingSample || showingConversation, let url = surfaceURL("stage") {
                stageReady = false
                stageWeb?.load(URLRequest(url: url))
            }
        }
        if !keepChatVisible { setChatVisible(false) }
        if stage?.isMiniaturized == true { stage?.deminiaturize(nil) }
        // AppKit cannot make a not-yet-visible window main. Ordering it key/front
        // establishes visibility and lets the normal titled-window policy choose main.
        NSApp.activate(ignoringOtherApps: true); stage?.makeKeyAndOrderFront(nil)
        if let view = stageWeb { stage?.makeFirstResponder(view) }
        stageWeb?.evaluateJavaScript("window.formeNative?.refresh?.()", completionHandler: nil)
        if stageReady { showRequestedExhibition() }
    }

    func showConversation(_ conversationID: String) {
        guard let base = backendURL else { return }
        showStage(keepChatVisible: true)
        var parts = URLComponents(url: base.appendingPathComponent("prototype/immersive-exhibition/light.html"), resolvingAgainstBaseURL: false)!
        if !conversationID.isEmpty { parts.queryItems = [URLQueryItem(name: "conversation", value: conversationID)] }
        parts.fragment = "chat"
        guard let url = parts.url else { return }
        pendingConversationURL = url
        stageReady = false
        stageWeb?.load(URLRequest(url: url))
    }

    func screenAt(_ point: NSPoint) -> NSScreen {
        NSScreen.screens.first(where: { $0.frame.contains(point) }) ?? NSScreen.main ?? NSScreen.screens[0]
    }

    func cancelPendingPetDrop() {
        guard pendingDropGeneration != nil else { return }
        pendingDropGeneration = nil; dragGeneration &+= 1
    }

    func cancelPetDragInputTracking() {
        guard isPetDragActive else { return }
        isPetDragActive = false; dragGeneration &+= 1
        dragTimer?.invalidate(); dragTimer = nil; dragProbeTicket = nil; dragWindows = []
        hideDragCandidate(animated: false)
    }

    func beginPetDrag() {
        pendingDropGeneration = nil
        dragGeneration &+= 1; isPetDragActive = true
        attachmentTimer?.invalidate(); attachmentTimer = nil
        attachment = nil; attachmentDockAnchor = nil; attachmentPlacementNormal = nil
        browserPageToReveal = nil
        attachmentSuspended = false
        attachmentVisibilityTimer?.invalidate(); attachmentVisibilityTimer = nil; attachmentVisibilityTransition = nil
        pet.alphaValue = 1
        attentionReadTicket = nil; context = [:]; sendContext()
        followProbeTicket = nil
        let interrupted = followCompletions; followCompletions.removeAll(); interrupted.forEach { $0() }
        noticeTimer?.invalidate(); noticePanel?.orderOut(nil)
        dragWindows = []; dragProbeTicket = nil; lastCandidateCheck = 0
        hideDragCandidate(animated: false)
        setChatVisible(false, animated: false)
        dragTimer?.invalidate()
        let timer = Timer(timeInterval: 1.0 / 30.0, repeats: true) { [weak self] _ in
            guard let self = self, self.isPetDragActive else { return }
            self.requestDragWindows()
        }
        timer.tolerance = 0.002; dragTimer = timer
        RunLoop.main.add(timer, forMode: .common)
        requestDragWindows()
    }

    func finishPetDrag(at point: NSPoint) {
        isPetDragActive = false; dragTimer?.invalidate(); dragTimer = nil
        dragGeneration &+= 1; dragProbeTicket = nil; dragWindows = []
        hideDragCandidate()
        let generation = dragGeneration
        pendingDropGeneration = generation
        let visible = screenAt(point).visibleFrame
        let primaryTop = NSScreen.screens.first?.frame.maxY ?? 0
        // Release resolves a fresh snapshot asynchronously, never the last hover candidate.
        dragProbeQueue.async { [weak self] in
            let windows = WindowProbe.visible()
            let target = WindowProbe.target(at: point, windows: windows, primaryTop: primaryTop)
            DispatchQueue.main.async {
                guard let self = self, !self.terminating, !self.isPetDragActive,
                      self.dragGeneration == generation else { return }
                if let target = target {
                    self.attach(to: target, at: point)
                } else if Docking.isScreenDockGesture(at: point, in: visible, hasWindowTarget: target != nil) {
                    self.detachToEdge(); self.showPetNotice("回到桌面边缘了")
                } else if AXIsProcessTrusted() {
                    // Only the exceptional AX hit test needs our nonactivating panel hidden.
                    let wasVisible = self.pet.isVisible
                    self.pet.orderOut(nil)
                    self.dragProbeQueue.async { [weak self] in
                        let target = self?.accessibilityWindowAt(point, primaryTop: primaryTop, onHit: { [weak self] in
                            DispatchQueue.main.async {
                                guard let self = self, !self.terminating else { return }
                                if wasVisible { self.pet.orderFrontRegardless() }
                            }
                        })
                        DispatchQueue.main.async {
                            guard let self = self else { return }
                            if wasVisible && !self.terminating { self.pet.orderFrontRegardless() }
                            guard !self.terminating, !self.isPetDragActive,
                                  self.dragGeneration == generation else { return }
                            if let target = target { self.attach(to: target, at: point) }
                            else { self.failPetDrop(noWindowMetadata: windows.isEmpty) }
                        }
                    }
                } else { self.failPetDrop(noWindowMetadata: windows.isEmpty) }
            }
        }
    }

    func failPetDrop(noWindowMetadata: Bool) {
        let diagnostic = noWindowMetadata
            ? "暂时没有取得其他窗口的位置。右键选择“开启窗口识别…”，也可以直接贴链接。"
            : "这里没有找到可附着的窗口，请拖到文章内容或标题栏上。"
        detachToEdge()
        context = ["error": diagnostic, "captureNeeded": false]
        sendContext(); petView.toolTip = diagnostic
        showPetNotice(diagnostic, duration: 4)
    }

    func attach(to target: AttachedWindow, at point: NSPoint? = nil) {
        attachmentTimer?.invalidate()
        isPetDragActive = false; dragTimer?.invalidate(); dragTimer = nil
        pendingDropGeneration = nil
        dragGeneration &+= 1; dragProbeTicket = nil; hideDragCandidate()
        attachment = target; attachmentPlacementNormal = nil; attachmentSuspensionReason = "none"
        browserPageToReveal = nil
        petView.attached = true; petView.needsDisplay = true
        let frame = target.frame
        let screen = screenAt(NSPoint(x: frame.midX, y: frame.midY)).visibleFrame
        let dropPoint = point ?? NSPoint(x: frame.minX + frame.width * 0.72, y: frame.maxY)
        attachmentDockAnchor = PetDockGeometry.anchor(for: frame, near: dropPoint, in: screen)
        attentionReadTicket = nil; lastAttentionRead = 0; lastKnownPageKey = nil
        context = metadataContext(for: target, status: "reading")
        parkAtAttachment(animated: true)
        if attachmentSuspended { setAttachmentSuspended(false) }
        let timer = Timer(timeInterval: 1.0 / 30.0, repeats: true) { [weak self] _ in self?.followAttachment() }
        timer.tolerance = 0.002; attachmentTimer = timer
        RunLoop.main.add(timer, forMode: .common)
        sendContext()
        refreshAttentionContextIfNeeded(force: true)
        if point != nil { presentChat(activate: false) }
        petView.toolTip = "已附着 \(target.appName)。单击展开或收起聊天，双击打开 Folio 主窗口。右键可回到屏幕边缘。"
        showPetNotice("已附着 \(target.appName)")
    }

    @objc func externalApplicationActivated(_ notification: Notification) {
        guard let application = notification.userInfo?[NSWorkspace.applicationUserInfoKey] as? NSRunningApplication,
              application.processIdentifier != getpid() else { return }
        // Record every external app, not just browsers: switching to another app
        // invalidates the old browser candidate rather than silently reusing it.
        lastExternalApplication = application
    }

    @objc func attachCurrentBrowser() {
        guard desktopTagAvailable else { return }
        let frontmost = NSWorkspace.shared.frontmostApplication
        let application = frontmost?.processIdentifier == getpid() ? lastExternalApplication : frontmost
        guard let application = application, !application.isTerminated, !application.isHidden,
              let bundleID = application.bundleIdentifier, BrowserAttentionReader.supports(bundleID) else {
            showPetNotice("先把要关注的浏览器窗口放到前面，再选择这个入口。", duration: 4); return
        }
        // optionOnScreenOnly is documented front-to-back. Resolve only the
        // foreground app's first normal visible window, never another browser.
        let rows = CGWindowListCopyWindowInfo([.optionOnScreenOnly, .excludeDesktopElements], kCGNullWindowID) as? [[String: Any]] ?? []
        guard let row = rows.first(where: { row in
            guard WindowValue.pid(row[kCGWindowOwnerPID as String]) == application.processIdentifier,
                  WindowValue.integer(row[kCGWindowLayer as String]) == 0,
                  let bounds = WindowValue.bounds(row[kCGWindowBounds as String]) else { return false }
            return bounds.width > 200 && bounds.height > 120
        }), let id = WindowValue.windowID(row[kCGWindowNumber as String]),
              let bounds = WindowValue.bounds(row[kCGWindowBounds as String]) else {
            showPetNotice("没有确认到前台浏览器窗口。可以把我拖到页面上，或直接贴链接。", duration: 4); return
        }
        beginPetDrag()
        attach(to: AttachedWindow(id: id, pid: application.processIdentifier,
                                 appName: application.localizedName ?? "浏览器", bundleID: bundleID,
                                 title: row[kCGWindowName as String] as? String ?? "", cgBounds: bounds))
        showChat()
    }

    @objc func openFocusedPage() {
        guard let selected = attachment, !terminating else { return }
        let page = browserPageToReveal
        let unavailable = "暂时找不到正在关注的窗口。可以回到原页面，把 Tag 拖到窗口上重新关联。"
        DispatchQueue.global(qos: .userInitiated).async { [weak self] in
            guard let self = self else { return }
            let isCurrent = {
                !self.terminating && BrowserContextIdentity.matches(selected, current: self.attachment)
                    && (page == nil || page == self.browserPageToReveal)
            }
            guard let target = self.currentWindowForReveal(selected) else {
                DispatchQueue.main.async {
                    if isCurrent() { self.reportFocusedPageUnavailable(unavailable) }
                }
                return
            }
            let browserRestored = page.flatMap { page in
                try? BrowserAttentionReader.reveal(page, in: target, isCurrent: { DispatchQueue.main.sync(execute: isCurrent) })
            }
            let canRaiseWindow = browserRestored != nil || AXIsProcessTrusted()
            let window = browserRestored == nil && canRaiseWindow ? self.accessibilityWindowForReveal(target) : nil
            DispatchQueue.main.async {
                guard isCurrent() else { return }
                guard canRaiseWindow else {
                    self.reportFocusedPageUnavailable("请在 Folio 菜单里选择“开启窗口识别…”，然后再打开正在关注的页面。")
                    return
                }
                guard let app = NSRunningApplication(processIdentifier: selected.pid),
                      !app.isTerminated, app.bundleIdentifier == selected.bundleID,
                      browserRestored != nil || window.map(self.raiseFocusedWindow) == true,
                      app.isActive || app.activate(options: []) else {
                    self.reportFocusedPageUnavailable(unavailable)
                    return
                }
                self.followAttachment(refreshContext: false) { [weak self] in
                    guard let self = self, BrowserContextIdentity.matches(selected, current: self.attachment) else { return }
                    self.refreshAttentionContextIfNeeded(force: true)
                    if page != nil, browserRestored != true {
                        self.showPetNotice("已打开原窗口，暂时没能切回原标签页。", duration: 4)
                    }
                }
            }
        }
    }

    private func currentWindowForReveal(_ selected: AttachedWindow) -> AttachedWindow? {
        guard selected.id != 0 else { return selected }
        guard let row = WindowProbe.matchingMetadata(for: selected, in: WindowProbe.metadata(for: selected.id)),
              row.layer == 0 else { return nil }
        var target = selected
        target.cgBounds = row.bounds
        return target
    }

    private func accessibilityWindowForReveal(_ selected: AttachedWindow) -> AXUIElement? {
        if selected.id == 0, let window = selected.axElement {
            var pid: pid_t = 0
            guard AXUIElementGetPid(window, &pid) == .success, pid == selected.pid,
                  axAttribute(window, kAXRoleAttribute as CFString) as? String == (kAXWindowRole as String) else { return nil }
            return window
        }
        return matchingAccessibilityWindow(for: selected)
    }

    private func raiseFocusedWindow(_ window: AXUIElement) -> Bool {
        if (axAttribute(window, kAXMinimizedAttribute as CFString) as? NSNumber)?.boolValue == true {
            guard AXUIElementSetAttributeValue(window, kAXMinimizedAttribute as CFString, kCFBooleanFalse) == .success else { return false }
        }
        guard AXUIElementPerformAction(window, kAXRaiseAction as CFString) == .success else { return false }
        // Some apps keep a different main window even after changing window order.
        _ = AXUIElementSetAttributeValue(window, kAXMainAttribute as CFString, kCFBooleanTrue)
        return true
    }

    private func reportFocusedPageUnavailable(_ message: String) {
        if attachmentSuspended { showFailure(message) }
        else { showPetNotice(message, duration: 4) }
    }

    func requestDragWindows() {
        guard isPetDragActive, dragProbeTicket == nil else { return }
        let ticket = UUID(), generation = dragGeneration
        dragProbeTicket = ticket
        dragProbeQueue.async { [weak self] in
            let windows = WindowProbe.visible()
            DispatchQueue.main.async {
                guard let self = self, self.dragProbeTicket == ticket else { return }
                self.dragProbeTicket = nil
                guard !self.terminating, self.isPetDragActive, self.dragGeneration == generation else { return }
                self.dragWindows = windows; self.lastCandidateCheck = ProcessInfo.processInfo.systemUptime
                self.updateDragCandidate(at: NSEvent.mouseLocation)
            }
        }
    }

    func updateDragCandidate(at point: NSPoint) {
        guard isPetDragActive else { return }
        // A cached real window remains a candidate even inside the screen's outer 8pt strip.
        // This immediate hit test also clears an old highlight on every mouse event.
        guard let target = WindowProbe.target(at: point, windows: dragWindows,
                primaryTop: NSScreen.screens.first?.frame.maxY ?? 0) else {
            hideDragCandidate(); return
        }
        let windowFrame = target.frame
        let visible = screenAt(NSPoint(x: windowFrame.midX, y: windowFrame.midY)).visibleFrame
        let presented = petView.gazeBodySnapshot
        let center = NSPoint(x: pet.frame.minX + presented.face.x, y: pet.frame.minY + presented.face.y)
        let anchor = PetDockGeometry.anchor(for: windowFrame, near: center, in: visible)
        if PetAttachmentVisibility.canFit(windowFrame, edge: anchor.edge, in: visible) {
            let placement = PetDockGeometry.window(windowFrame, anchor: anchor, in: visible)
            petView.previewDragAdhesion(at: placement.contact)
        } else { petView.previewDragAdhesion(at: nil) }
        if candidatePanel == nil {
            let panel = NSPanel(contentRect: .zero, styleMask: [.borderless, .nonactivatingPanel], backing: .buffered, defer: false)
            panel.isOpaque = false; panel.backgroundColor = .clear; panel.hasShadow = false
            panel.level = .floating; panel.ignoresMouseEvents = true; panel.hidesOnDeactivate = false
            panel.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary]
            let outline = CandidateOutlineView(frame: .zero); outline.setAccessibilityElement(false)
            panel.contentView = outline; panel.alphaValue = 0; candidatePanel = panel
        }
        let rect = target.frame.insetBy(dx: -3, dy: -3)
        let key = "\(target.pid):\(target.id)"
        guard let panel = candidatePanel else { return }
        if candidateToken == key, candidateTransition?.toFrame == rect || (candidateTransition == nil && panel.frame == rect) { return }
        let wasVisible = panel.isVisible && panel.alphaValue > 0.001
        if !wasVisible { panel.setFrame(rect, display: true); panel.alphaValue = 0 }
        candidateToken = key
        panel.orderFrontRegardless(); pet.orderFrontRegardless()
        animateCandidate(to: rect, alpha: 1, duration: wasVisible ? 0.13 : 0.11)
    }

    func hideDragCandidate(animated: Bool = true) {
        petView?.previewDragAdhesion(at: nil)
        candidateToken = nil
        guard let panel = candidatePanel else { return }
        if !animated || NSWorkspace.shared.accessibilityDisplayShouldReduceMotion {
            candidateTransition = nil; candidateTransitionTimer?.invalidate(); candidateTransitionTimer = nil
            panel.alphaValue = 0; panel.orderOut(nil); return
        }
        guard panel.isVisible, candidateTransition?.toAlpha != 0 else { return }
        animateCandidate(to: panel.frame, alpha: 0, duration: 0.09)
    }

    func animateCandidate(to frame: NSRect, alpha: CGFloat, duration: TimeInterval) {
        guard let panel = candidatePanel else { return }
        if NSWorkspace.shared.accessibilityDisplayShouldReduceMotion {
            candidateTransition = nil; candidateTransitionTimer?.invalidate(); candidateTransitionTimer = nil
            panel.setFrame(frame, display: true); panel.alphaValue = alpha
            if alpha == 0 { panel.orderOut(nil) }; return
        }
        candidateTransition = ChatTransition(fromFrame: panel.frame, toFrame: frame,
            fromAlpha: panel.alphaValue, toAlpha: alpha, startedAt: ProcessInfo.processInfo.systemUptime,
            duration: duration, showing: alpha > 0)
        guard candidateTransitionTimer == nil else { return }
        let timer = Timer(timeInterval: 1.0 / 60.0, repeats: true) { [weak self] _ in
            guard let self = self, let transition = self.candidateTransition, let panel = self.candidatePanel else { return }
            let value = transition.value(at: ProcessInfo.processInfo.systemUptime)
            panel.setFrame(value.frame, display: true); panel.alphaValue = value.alpha
            if value.complete {
                self.candidateTransition = nil; self.candidateTransitionTimer?.invalidate(); self.candidateTransitionTimer = nil
                if value.alpha == 0 { panel.orderOut(nil) }
            }
        }
        timer.tolerance = 0.001; candidateTransitionTimer = timer
        RunLoop.main.add(timer, forMode: .common)
    }

    func axAttribute(_ element: AXUIElement, _ attribute: CFString) -> CFTypeRef? {
        AXUIElementSetMessagingTimeout(element, 0.12)
        var value: CFTypeRef?
        return AXUIElementCopyAttributeValue(element, attribute, &value) == .success ? value : nil
    }

    func axElementAttribute(_ element: AXUIElement, _ attribute: CFString) -> AXUIElement? {
        guard let value = axAttribute(element, attribute), CFGetTypeID(value) == AXUIElementGetTypeID() else { return nil }
        return (value as! AXUIElement)
    }

    func accessibilityBounds(_ element: AXUIElement, minimumSize: NSSize = NSSize(width: 200, height: 120)) -> CGRect? {
        guard let rawPosition = axAttribute(element, kAXPositionAttribute as CFString),
              let rawSize = axAttribute(element, kAXSizeAttribute as CFString),
              CFGetTypeID(rawPosition) == AXValueGetTypeID(), CFGetTypeID(rawSize) == AXValueGetTypeID() else { return nil }
        let positionValue = rawPosition as! AXValue, sizeValue = rawSize as! AXValue
        guard AXValueGetType(positionValue) == .cgPoint, AXValueGetType(sizeValue) == .cgSize else { return nil }
        var position = CGPoint.zero, size = CGSize.zero
        guard AXValueGetValue(positionValue, .cgPoint, &position), AXValueGetValue(sizeValue, .cgSize, &size),
              [position.x, position.y, size.width, size.height].allSatisfy({ $0.isFinite }),
              size.width > minimumSize.width, size.height > minimumSize.height else { return nil }
        return CGRect(origin: position, size: size)
    }

    func accessibilityWindowAt(_ point: NSPoint, primaryTop: CGFloat, onHit: (() -> Void)? = nil) -> AttachedWindow? {
        guard AXIsProcessTrusted() else { return nil }
        // The caller hides only our own panel on main before this background hit test.
        let system = AXUIElementCreateSystemWide()
        AXUIElementSetMessagingTimeout(system, 0.12)
        var hit: AXUIElement?
        let result = AXUIElementCopyElementAtPosition(system, Float(point.x), Float(primaryTop - point.y), &hit)
        // Reveal our panel as soon as the hit-test is done; slower attribute queries stay background-only.
        onHit?()
        guard result == .success, let element = hit else { return nil }
        var pid: pid_t = 0
        guard AXUIElementGetPid(element, &pid) == .success, pid > 0, pid != getpid() else { return nil }
        var selected = axElementAttribute(element, kAXWindowAttribute as CFString)
        if selected == nil, (axAttribute(element, kAXRoleAttribute as CFString) as? String) == (kAXWindowRole as String) { selected = element }
        if selected == nil { selected = axElementAttribute(element, kAXTopLevelUIElementAttribute as CFString) }
        guard let window = selected else { return nil }
        AXUIElementSetMessagingTimeout(window, 0.12)
        guard let bounds = accessibilityBounds(window) else { return nil }
        let app = NSRunningApplication(processIdentifier: pid)
        return AttachedWindow(id: 0, pid: pid, appName: app?.localizedName ?? "应用", bundleID: app?.bundleIdentifier,
                              title: axAttribute(window, kAXTitleAttribute as CFString) as? String ?? "",
                              cgBounds: bounds, axElement: window)
    }

    func matchingAccessibilityWindow(for target: AttachedWindow) -> AXUIElement? {
        guard AXIsProcessTrusted() else { return nil }
        let app = AXUIElementCreateApplication(target.pid)
        AXUIElementSetMessagingTimeout(app, 0.2)
        guard let windows = axAttribute(app, kAXWindowsAttribute as CFString) as? [AXUIElement] else { return nil }
        let matches = windows.filter { window in
            guard let bounds = accessibilityBounds(window) else { return false }
            return abs(bounds.minX - target.cgBounds.minX) < 12 && abs(bounds.minY - target.cgBounds.minY) < 12
                && abs(bounds.width - target.cgBounds.width) < 12 && abs(bounds.height - target.cgBounds.height) < 12
        }
        return matches.count == 1 ? matches.first : nil
    }

    func showPetNotice(_ text: String, duration: TimeInterval = 2.8) {
        guard desktopTagAvailable, !attachmentSuspended else { return }
        noticeTimer?.invalidate()
        if noticePanel == nil {
            let panel = NSPanel(contentRect: .zero, styleMask: [.borderless, .nonactivatingPanel], backing: .buffered, defer: false)
            panel.isOpaque = false; panel.backgroundColor = .clear; panel.hasShadow = true
            panel.appearance = NSAppearance(named: .darkAqua)
            panel.level = .floating; panel.hidesOnDeactivate = false; panel.ignoresMouseEvents = true
            panel.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary]
            panel.title = "Tag · 提示"
            panel.setAccessibilityIdentifier("forme.pet.notice")
            noticePanel = panel
        }
        let screen = screenAt(NSPoint(x: pet.frame.midX, y: pet.frame.midY)).visibleFrame
        let width = min(CGFloat(260), screen.width - 32)
        let font = NSFont.systemFont(ofSize: 12)
        let measured = (text as NSString).boundingRect(with: NSSize(width: width - 24, height: 120),
                                                      options: [.usesLineFragmentOrigin, .usesFontLeading],
                                                      attributes: [.font: font])
        let height = max(CGFloat(38), ceil(measured.height) + 20)
        let content = NSView(frame: NSRect(x: 0, y: 0, width: width, height: height))
        content.wantsLayer = true; content.layer?.cornerRadius = 9
        content.layer?.backgroundColor = NSColor(srgbRed: 27.0 / 255.0, green: 29.0 / 255.0, blue: 32.0 / 255.0, alpha: 1).cgColor
        content.layer?.borderColor = NSColor.white.withAlphaComponent(0.12).cgColor; content.layer?.borderWidth = 0.5
        let label = NSTextField(wrappingLabelWithString: text)
        label.font = font; label.textColor = .labelColor
        label.frame = NSRect(x: 12, y: 10, width: width - 24, height: height - 20)
        content.addSubview(label); noticePanel?.contentView = content
        noticePanel?.setFrame(Docking.chatFrame(near: pet.frame, screen: screen, size: NSSize(width: width, height: height)), display: true)
        noticePanel?.orderFrontRegardless(); pet.orderFrontRegardless()
        noticeTimer = Timer.scheduledTimer(withTimeInterval: duration, repeats: false) { [weak self] _ in self?.noticePanel?.orderOut(nil) }
    }

    @objc func enableWindowRecognition() {
        guard desktopTagAvailable else { return }
        if AXIsProcessTrusted() {
            showPetNotice("窗口识别已开启。")
            refreshAttentionContextIfNeeded(force: true)
            return
        }
        let alert = NSAlert()
        alert.messageText = "开启更准确的窗口识别？"
        alert.informativeText = "Folio 使用辅助功能权限定位和跟随你主动吸附的窗口。对于可识别的浏览器页面和微信公众号文章，Tag 会显示标题和地址，并在你主动关联、提问或收藏时尝试读取正文。\n\n你也可以暂不开启，点开 Tag 粘贴文章链接。"
        alert.addButton(withTitle: "继续并请求授权"); alert.addButton(withTitle: "暂不")
        NSApp.activate(ignoringOtherApps: true)
        guard alert.runModal() == .alertFirstButtonReturn else { return }
        let options = [kAXTrustedCheckOptionPrompt.takeUnretainedValue() as String: true] as CFDictionary
        let trusted = AXIsProcessTrustedWithOptions(options)
        showPetNotice(trusted ? "窗口识别已开启。" : "请在系统提示中允许当前版本的 Folio 使用辅助功能。", duration: 4)
        if trusted { refreshAttentionContextIfNeeded(force: true) }
    }

    func parkAtAttachment(animated: Bool = false) {
        guard let target = attachment else { return }
        let frame = target.frame
        let screen = screenAt(NSPoint(x: frame.midX, y: frame.midY)).visibleFrame
        let anchor = attachmentDockAnchor ?? PetWindowAnchor(edge: .top, fraction: 0.72)
        attachmentDockAnchor = anchor
        let placement = PetDockGeometry.window(frame, anchor: anchor, in: screen, previousNormal: attachmentPlacementNormal)
        attachmentPlacementNormal = placement.contact.normal
        petView.dock(to: placement, animated: animated)
        if chat?.isVisible == true { positionChat() }
    }

    func followScene(at time: TimeInterval) -> PetWindowScene {
        if let cache = followSceneCache, time - cache.recordedAt < 0.1 { return cache }
        let scene = PetWindowScene.capture(at: time); followSceneCache = scene; return scene
    }

    func refreshedWindow(_ selected: AttachedWindow, scene: PetWindowScene) -> PetWindowFollowResult {
        // A helper can own a WindowServer window without an AppKit app record.
        if let app = NSRunningApplication(processIdentifier: selected.pid) {
            if app.isTerminated {
                return PetWindowFollowResult(target: selected, availability: .closed, scene: scene)
            }
            if app.isHidden {
                missingWindow = nil
                return PetWindowFollowResult(target: selected, availability: .suspended, scene: scene)
            }
        }
        return refreshedRunningWindow(selected, scene: scene)
    }

    private func availabilityWhileMissing(_ token: UUID, at time: TimeInterval) -> PetWindowAvailability {
        // Snapshots are cached; only a newer observation can advance elapsed time.
        guard let missing = missingWindow, missing.token == token else {
            missingWindow = (token, time)
            return .suspended
        }
        return time - missing.since >= 2 ? .closed : .suspended
    }

    // Separate WindowServer/AX state from process discovery so headless fixtures need no running GUI app.
    func refreshedRunningWindow(_ selected: AttachedWindow, scene: PetWindowScene) -> PetWindowFollowResult {
        var target = selected
        func result(_ state: PetWindowAvailability) -> PetWindowFollowResult {
            PetWindowFollowResult(target: target, availability: state, scene: scene)
        }
        if target.id != 0 {
            let current = WindowProbe.matchingMetadata(for: selected, in: WindowProbe.metadata(for: target.id))
            let retained = WindowProbe.matchingMetadata(for: selected, in: scene.all)
            let front = WindowProbe.matchingMetadata(for: selected, in: scene.frontToBack)
            if let row = current ?? retained ?? front {
                missingWindow = nil
                target.cgBounds = row.bounds
                // Ordered-out/minimized/other-space metadata is a suspension, never closure.
                let onScreen = row.onScreen ?? (front != nil)
                return result(onScreen ? .visible : .suspended)
            }
            guard scene.all != nil else {
                missingWindow = nil
                return result(.suspended)
            }
            return result(availabilityWhileMissing(target.token, at: scene.recordedAt))
        }
        guard AXIsProcessTrusted(), let element = target.axElement else {
            missingWindow = nil
            return result(.suspended)
        }
        AXUIElementSetMessagingTimeout(element, 0.12)
        var pid: pid_t = 0
        let pidResult = AXUIElementGetPid(element, &pid)
        if pidResult == .invalidUIElement { return result(availabilityWhileMissing(target.token, at: scene.recordedAt)) }
        guard pidResult == .success, pid == target.pid else {
            missingWindow = nil
            return result(.suspended)
        }
        var minimizedValue: CFTypeRef?
        let minimizedResult = AXUIElementCopyAttributeValue(element, kAXMinimizedAttribute as CFString, &minimizedValue)
        if minimizedResult == .invalidUIElement { return result(availabilityWhileMissing(target.token, at: scene.recordedAt)) }
        missingWindow = nil
        if let minimized = minimizedValue as? NSNumber, minimized.boolValue { return result(.suspended) }
        guard minimizedResult == .success || minimizedResult == .attributeUnsupported else { return result(.suspended) }
        guard let bounds = accessibilityBounds(element, minimumSize: .zero) else { return result(.suspended) }
        target.cgBounds = bounds
        return result(.visible)
    }

    func setAttachmentSuspended(_ suspended: Bool) {
        guard attachmentSuspended != suspended else { return }
        attachmentSuspended = suspended
        attachmentVisibilityTimer?.invalidate(); attachmentVisibilityTimer = nil; attachmentVisibilityTransition = nil
        if suspended {
            // Conceal immediately once another window owns this area; preserve the relationship/context.
            pet.alphaValue = 0; pet.orderOut(nil); petView.pauseAttachmentPresentation()
            noticeTimer?.invalidate(); noticePanel?.orderOut(nil)
        } else {
            pet.alphaValue = NSWorkspace.shared.accessibilityDisplayShouldReduceMotion ? 1 : 0
            petView.updateMotionPreferences(); pet.orderFrontRegardless()
            if NSWorkspace.shared.accessibilityDisplayShouldReduceMotion { petView.refreshInputHit(); return }
            let transition = PetScalarTransition(from: 0, to: 1, startedAt: ProcessInfo.processInfo.systemUptime, duration: 0.16)
            attachmentVisibilityTransition = transition
            let timer = Timer(timeInterval: 1.0 / 60.0, repeats: true) { [weak self] _ in self?.advanceAttachmentVisibility() }
            timer.tolerance = 0.001; attachmentVisibilityTimer = timer; RunLoop.main.add(timer, forMode: .common)
        }
    }

    func advanceAttachmentVisibility(at time: TimeInterval = ProcessInfo.processInfo.systemUptime) {
        guard let transition = attachmentVisibilityTransition, !terminating, !attachmentSuspended else { return }
        let value = transition.value(at: time); pet.alphaValue = value.amount; petView.refreshInputHit()
        if value.complete {
            attachmentVisibilityTimer?.invalidate(); attachmentVisibilityTimer = nil; attachmentVisibilityTransition = nil
        }
    }

    func restoreStandalonePresentation() {
        attachmentSuspended = false
        attachmentVisibilityTimer?.invalidate(); attachmentVisibilityTimer = nil; attachmentVisibilityTransition = nil
        guard desktopTagAvailable else { return }
        pet.alphaValue = 1; petView.updateMotionPreferences(); pet.orderFrontRegardless()
    }

    func followAttachment(refreshContext: Bool = true, completion: (() -> Void)? = nil) {
        if let completion = completion { followCompletions.append(completion) }
        guard let selected = attachment else {
            let callbacks = followCompletions; followCompletions.removeAll(); callbacks.forEach { $0() }; return
        }
        guard followProbeTicket == nil, !isPetDragActive, !petView.inputLifecycleSnapshot.forcingCapture, !terminating else { return }
        let ticket = UUID(); followProbeTicket = ticket
        followProbeQueue.async { [weak self] in
            guard let self = self else { return }
            let scene = self.followScene(at: ProcessInfo.processInfo.systemUptime)
            let refreshed = self.refreshedWindow(selected, scene: scene)
            DispatchQueue.main.async {
                guard self.followProbeTicket == ticket else { return }
                self.followProbeTicket = nil
                let callbacks = self.followCompletions; self.followCompletions.removeAll()
                guard !self.terminating, BrowserContextIdentity.matches(selected, current: self.attachment) else {
                    callbacks.forEach { $0() }; return
                }
                // Protect mouseDown capture as well as the post-threshold dragging phase.
                guard !self.petView.inputLifecycleSnapshot.forcingCapture else { callbacks.forEach { $0() }; return }
                if refreshed.availability == .closed {
                    self.detachToEdge(); callbacks.forEach { $0() }; return
                }
                let target = refreshed.target
                let moved = self.attachment?.cgBounds != target.cgBounds
                self.attachment = target
                let frame = target.frame
                let screen = self.screenAt(NSPoint(x: frame.midX, y: frame.midY)).visibleFrame
                let anchor = self.attachmentDockAnchor ?? PetWindowAnchor(edge: .top, fraction: 0.72)
                let placement = PetDockGeometry.window(frame, anchor: anchor, in: screen, previousNormal: self.attachmentPlacementNormal)
                let artwork = PetMotion.artwork(contact: placement.contact, frame: placement.frame,
                    pose: PetPose(translation: .zero, scale: NSSize(width: 1, height: 1), tilt: 0, eyeOpenness: 1))
                let body = PetInputHitRegion.bodyBounds(artwork, in: placement.frame)
                let primaryTop = NSScreen.screens.first?.frame.maxY ?? 0
                let canFit = PetAttachmentVisibility.canFit(frame, edge: anchor.edge, in: screen)
                let withinScreen = screen.insetBy(dx: -0.5, dy: -0.5).contains(body)
                var suspended = refreshed.availability != .visible || !canFit || !withinScreen
                var reason = refreshed.availability != .visible ? "availability:suspended"
                    : !canFit ? "canfit" : !withinScreen ? "screen" : "none"
                func coverageReason(_ kind: String, _ row: PetWindowMetadata?, _ point: NSPoint?) -> String {
                    guard let row = row else { return kind + "(empty-region)" }
                    let name = String((row.ownerName ?? "unknown").prefix(48))
                    let location = point.map { String(format: "%.1f,%.1f", Double($0.x), Double($0.y)) } ?? "unknown"
                    return "\(kind)(app=\(name),pid=\(row.pid),id=\(row.id),layer=\(row.layer),point=\(location))"
                }
                if !suspended {
                    if let windows = refreshed.scene.frontToBack {
                        suspended = PetAttachmentVisibility.isCovered(body: body, contact: placement.contact,
                            target: target, windows: windows, primaryTop: primaryTop, ownPID: getpid(),
                            fillets: artwork.fillets, artworkFrame: placement.frame, maximumLayer: self.pet.level.rawValue,
                            onCovered: { row, point in reason = coverageReason("coveredTarget", row, point) })
                        let presented = self.petView.gazeBodySnapshot
                        let presentedBody = PetInputHitRegion.bodyBounds(presented, in: self.pet.frame)
                        let withinOwner = presentedBody.intersection(frame)
                        if !suspended && withinOwner.width * withinOwner.height >= presentedBody.width * presentedBody.height * 0.8 {
                            suspended = PetAttachmentVisibility.isCovered(body: presentedBody, contact: placement.contact,
                                target: target, windows: windows, primaryTop: primaryTop, ownPID: getpid(),
                                fillets: presented.adhesionAmount > 0.05 ? presented.fillets : [], artworkFrame: self.pet.frame,
                                maximumLayer: self.pet.level.rawValue, onCovered: { row, point in reason = coverageReason("coveredPresented", row, point) })
                        }
                    } else { suspended = true; reason = "sceneUnavailable" }
                }
                self.attachmentSuspensionReason = reason
                if suspended { self.setAttachmentSuspended(true) }
                if moved || (!suspended && self.attachmentSuspended) { self.parkAtAttachment() }
                if !suspended { self.setAttachmentSuspended(false) }
                callbacks.forEach { $0() }
                if refreshContext && !suspended { self.refreshAttentionContextIfNeeded() }
            }
        }
    }

    @objc func detachToEdge() {
        guard desktopTagAvailable else { return }
        detachToScreenEdge(nil)
    }

    @objc func dockToScreenEdge(_ sender: NSMenuItem) {
        guard desktopTagAvailable, let raw = sender.representedObject as? String, let edge = DockEdge(rawValue: raw) else { return }
        detachToScreenEdge(edge)
    }

    func detachToScreenEdge(_ edge: DockEdge?) {
        attachmentTimer?.invalidate(); attachmentTimer = nil; attachment = nil; context = [:]
        browserPageToReveal = nil
        attachmentSuspensionReason = "none"
        followProbeTicket = nil; attachmentPlacementNormal = nil; pendingDropGeneration = nil
        isPetDragActive = false; dragTimer?.invalidate(); dragTimer = nil; dragGeneration &+= 1
        dragProbeTicket = nil; dragWindows = []; hideDragCandidate()
        let callbacks = followCompletions; followCompletions.removeAll(); callbacks.forEach { $0() }
        attachmentDockAnchor = nil
        attentionReadTicket = nil; lastAttentionRead = 0; lastKnownPageKey = nil
        noticeTimer?.invalidate(); noticePanel?.orderOut(nil)
        hideDragCandidate()
        petView.attached = false; petView.needsDisplay = true
        let screen = screenAt(NSPoint(x: pet.frame.midX, y: pet.frame.midY)).visibleFrame
        let result = Docking.origin(for: pet.frame, in: screen)
        let point = NSPoint(x: pet.frame.midX, y: pet.frame.midY)
        petView.dock(to: PetDockGeometry.screen(edge: edge ?? result.1, near: point, in: screen), animated: desktopTagAvailable)
        restoreStandalonePresentation()
        positionChat(); sendContext()
        petView.toolTip = "单击展开或收起聊天，双击打开 Folio 主窗口。拖到文章窗口可关联页面，右键查看更多"
    }

    func sendContext(_ extra: [String: Any] = [:]) {
        let status = browserPageToReveal.flatMap { page in
            attachment.map { ["attachmentId": $0.token.uuidString, "url": page.url, "title": page.title] }
        } ?? context
        attachmentStatusItem?.title = AttachmentMenuLabel.title(for: attachment, context: status)
        contextVersion += 1
        var value = context; for (key, item) in extra { value[key] = item }
        value["contextVersion"] = contextVersion
        guard let bytes = try? JSONSerialization.data(withJSONObject: value), let json = String(data: bytes, encoding: .utf8) else { return }
        chatWeb?.evaluateJavaScript("window.formeNative?.receiveContext(\(json))", completionHandler: nil)
    }

    func metadataContext(for target: AttachedWindow, status: String, hint: String = "") -> [String: Any] {
        let attachmentID = target.token.uuidString
        let revision = context["attachmentId"] as? String == attachmentID ? context["pageRevision"] as? String : nil
        let wechat = WeChatArticleAccessibility.supports(target.bundleID)
        let title = wechat ? "微信窗口" : (target.title.isEmpty ? "\(target.appName) · 当前页面" : target.title)
        var value: [String: Any] = ["attachmentId": attachmentID, "pageRevision": revision ?? attachmentID,
                                    "appName": target.appName, "title": title, "captureNeeded": true,
                                    "contextStatus": status, "contextHint": hint, "attention": true, "pageContentAvailable": false]
        if wechat { value["sourceType"] = "wechat-window" }
        return value
    }

    func finishAttentionRead(_ ticket: UUID?) {
        if let ticket = ticket, attentionReadTicket == ticket { attentionReadTicket = nil }
    }

    func refreshAttentionContextIfNeeded(force: Bool = false) {
        guard attachment != nil, !attachmentSuspended, attentionReadTicket == nil, force || chatWantsVisible else { return }
        if !force, context["contextStatus"] as? String == "unsupported" { return }
        let time = ProcessInfo.processInfo.systemUptime
        guard force || time - lastAttentionRead >= 2.4 else { return }
        lastAttentionRead = time
        // After System Settings grants access, the existing attachment can be
        // identified without moving Tag or opening another chat.
        if !force, context["contextStatus"] as? String == "needs_window_recognition", !AXIsProcessTrusted() { return }
        let ticket = UUID(); attentionReadTicket = ticket
        captureContext(requestID: nil, purpose: "conversation", attentionTicket: ticket)
    }

    private func hasPreviewTarget(_ preview: AttachmentPreviewTarget) -> Bool {
        context["contextStatus"] as? String == "ready" && attachment?.token.uuidString == preview.attachmentID
            && AttachmentPreviewTarget(context) == preview
    }

    func captureContext(requestID: String?, purpose: String = "collect", attentionTicket: UUID? = nil,
                        geometryConfirmed: Bool = false, preview: AttachmentPreviewTarget? = nil) {
        if let preview = preview, !hasPreviewTarget(preview) {
            sendContext(["error": "已识别的页面有变化，请确认当前页后重新读取。", "requestId": requestID ?? ""])
            return
        }
        if !geometryConfirmed, let selected = attachment {
            followAttachment(refreshContext: false) { [weak self] in
                guard let self = self else { return }
                guard BrowserContextIdentity.matches(selected, current: self.attachment) else {
                    self.finishAttentionRead(attentionTicket)
                    if requestID != nil { self.sendContext(["error": "关注的窗口已经变化，请围绕当前页面再试一次。", "requestId": requestID ?? ""]) }
                    return
                }
                self.captureContext(requestID: requestID, purpose: purpose, attentionTicket: attentionTicket,
                                    geometryConfirmed: true, preview: preview)
            }
            return
        }
        if attachmentSuspended {
            finishAttentionRead(attentionTicket)
            if requestID != nil { sendContext(["error": "关注的窗口暂时收起了，恢复原窗口后再试。", "requestId": requestID ?? ""]) }
            return
        }
        guard let target = attachment else {
            finishAttentionRead(attentionTicket)
            if requestID != nil { sendContext(["error": "先把我拖到文章窗口上，或直接贴一个链接给我。", "requestId": requestID ?? ""]) }
            return
        }
        let quiet = purpose == "conversation" || preview != nil
        let wechat = WeChatArticleAccessibility.supports(target.bundleID)
        guard wechat || BrowserAttentionReader.supports(target.bundleID) else {
            finishAttentionRead(attentionTicket)
            let hint = "已关注这个窗口，暂时无法直接读取页面。把链接或正文贴给我，就能围绕它聊。"
            context = metadataContext(for: target, status: "unsupported", hint: hint)
            sendContext(requestID == nil ? [:] : ["error": hint, "requestId": requestID ?? ""])
            return
        }
        let hadConfirmedURL = (context["url"] as? String).flatMap(BrowserContextIdentity.webURL) != nil
        captureQueue.async { [weak self] in
            let outcome: Result<BrowserPageSnapshot, NSError>
            do {
                if wechat {
                    let snapshot = try WeChatArticleAccessibility.read(target, includeBody: requestID != nil, expectedURL: preview?.pageKey)
                    if let preview = preview, !preview.matches(snapshot) { throw BrowserAttentionReader.changed() }
                    outcome = .success(snapshot)
                } else {
                    var snapshot = try BrowserAttentionReader.read(target, requestPermission: !quiet)
                    if let preview = preview, !preview.matches(snapshot) { throw BrowserAttentionReader.changed() }
                    // Passive attention refreshes read metadata only.
                    if requestID != nil {
                        let content = BrowserAccessibilityReader.read(target, expectedURL: snapshot.url, includeSelection: preview == nil)
                        if content != nil || preview != nil {
                            let verified = try BrowserAttentionReader.read(target)
                            guard verified.browserWindowID == snapshot.browserWindowID,
                                  verified.browserTabID == snapshot.browserTabID,
                                  BrowserContextIdentity.pageKey(verified.url) == BrowserContextIdentity.pageKey(snapshot.url) else { throw BrowserAttentionReader.changed() }
                        }
                        if let content = content {
                            snapshot.text = content.text; snapshot.selection = content.selection
                            snapshot.textTruncated = content.truncated; snapshot.contentSource = "browser-accessibility"
                        }
                    }
                    outcome = .success(snapshot)
                }
            } catch { outcome = .failure(error as NSError) }
            DispatchQueue.main.async {
                guard let self = self else { return }
                self.followAttachment(refreshContext: false) { [weak self] in
                    guard let self = self else { return }
                    self.finishAttentionRead(attentionTicket)
                    guard BrowserContextIdentity.matches(target, current: self.attachment) else {
                        if requestID != nil { self.sendContext(["error": "关注的窗口已经变化，请围绕当前页面再试一次。", "requestId": requestID ?? ""]) }
                        return
                    }
                    guard !self.attachmentSuspended else {
                        if requestID != nil { self.sendContext(["error": "关注的窗口暂时收起了，恢复原窗口后再试。", "requestId": requestID ?? ""]) }
                        return
                    }
                    if let preview = preview, !self.hasPreviewTarget(preview) {
                        self.sendContext(["error": "已识别的页面有变化，请确认当前页后重新读取。", "requestId": requestID ?? ""])
                        return
                    }
                    switch outcome {
                    case .success(let snapshot):
                        // A passive tab switch updates the chat candidate. The menu follows the
                        // page chosen on attachment or by a later explicit read.
                        if BrowserAttentionReader.supportsPageReveal(target.bundleID), self.browserPageToReveal == nil || preview != nil {
                            self.browserPageToReveal = BrowserPageRevealTarget(snapshot: snapshot)
                        }
                        let pageKey = BrowserContextIdentity.pageKey(snapshot.url)
                        let previousKey = self.lastKnownPageKey
                        let previousRevision = self.context["pageRevision"] as? String ?? target.token.uuidString
                        var value = self.metadataContext(for: target, status: "ready", hint: "正在关注这页，是否收藏由你决定。")
                        value["url"] = snapshot.url
                        value["title"] = snapshot.title.isEmpty ? target.title : snapshot.title
                        if wechat { value["sourceType"] = "wechat-article" }
                        value["captureNeeded"] = false
                        value["pageKey"] = pageKey
                        value["pageRevision"] = BrowserContextIdentity.pageRevision(previousKey: previousKey, previousRevision: previousRevision, newKey: pageKey)
                        value["browserWindowId"] = snapshot.browserWindowID
                        value["browserTabId"] = snapshot.browserTabID
                        if !snapshot.text.isEmpty || !snapshot.selection.isEmpty {
                            value["text"] = snapshot.text; value["selection"] = snapshot.selection
                            value["textTruncated"] = snapshot.textTruncated
                            value["contentSource"] = snapshot.contentSource
                            value["pageContentAvailable"] = true
                        }
                        self.lastKnownPageKey = pageKey
                        self.context = value
                        self.sendContext(requestID == nil ? [:] : ["requestId": requestID ?? "", "purpose": purpose,
                                                                  "requiresConfirmation": purpose == "collect" && !hadConfirmedURL])
                    case .failure(let error):
                        if preview != nil {
                            let hint = error.code == 2 ? "已识别的页面有变化，请确认当前页后重新读取。" : "暂时无法核对已识别的页面，请重试。"
                            self.sendContext(["error": hint, "requestId": requestID ?? ""])
                            return
                        }
                        if wechat {
                            let needsPermission = error.domain == WeChatArticleAccessibility.permissionError.domain
                            let hint: String
                            if needsPermission {
                                hint = "当前版本的 Folio 尚未获得辅助功能授权。开启后会自动重新识别。"
                            } else if error.code == 2 {
                                hint = "微信窗口中的页面已变化，请在当前文章中重试。"
                            } else {
                                hint = "已吸附到微信窗口。暂时没确认到公众号文章的标题和地址，可以复制文章链接或正文后粘贴。"
                            }
                            self.context = self.metadataContext(for: target, status: needsPermission ? "needs_window_recognition" : "unsupported", hint: hint)
                            self.sendContext(requestID == nil ? [:] : ["error": hint, "requestId": requestID ?? ""])
                            return
                        }
                        let permissionNeeded = [-1743, -1744].contains(error.code)
                        let hint = permissionNeeded
                            ? "尚未获准读取浏览器页面。可以点“允许读取”选择授权，或直接贴链接。"
                            : "暂时没确认到所选窗口的页面。仍在关注这个窗口，可以贴链接或稍后再试。"
                        // A failed refresh must not silently keep a URL from an older page.
                        self.context = self.metadataContext(for: target, status: permissionNeeded ? "needs_permission" : "unavailable", hint: hint)
                        self.sendContext(requestID == nil ? [:] : ["error": hint, "requestId": requestID ?? ""])
                    }
                }
            }
        }
    }

    func userContentController(_ userContentController: WKUserContentController, didReceive message: WKScriptMessage) {
        guard desktopTagAvailable, message.frameInfo.isMainFrame, let base = backendURL,
              message.frameInfo.securityOrigin.host == "127.0.0.1",
              message.frameInfo.securityOrigin.protocol == "http",
              message.frameInfo.securityOrigin.port == base.port,
              let body = message.body as? [String: Any], let action = body["action"] as? String else { return }
        switch action {
        case "openStage":
            pendingExhibitionID = body["exhibitionId"] as? String
            pendingCollectionID = body["collectionId"] as? String
            openStage()
        case "openConversation":
            guard message.webView === chatWeb, let conversationID = body["conversationId"] as? String,
                  conversationID.isEmpty || conversationID.range(of: "^[a-zA-Z0-9_-]{1,150}$", options: .regularExpression) != nil else { return }
            showConversation(conversationID)
        case "closeChat": setChatVisible(false)
        case "showChat": showChat()
        case "chatDragRegion":
            guard message.webView === chatWeb, let surface = chatSurface, let dragView = chatDragView else { return }
            let region = (body["region"] as? [String: Any]).flatMap { ChatDragView.region($0, in: surface.bounds) }
            if let region = region { dragView.frame = region }
            dragView.isHidden = region == nil
        case "workspaceConversation":
            guard message.webView === stageWeb, let visible = body["visible"] as? Bool else { return }
            stage?.title = visible ? "Folio · 和 Tag 对话" : "Folio · 私人收藏馆"
        case "showWorkspaceChat":
            guard message.webView === stageWeb,
                  let request = body["request"] as? [String: Any],
                  let requestID = request["requestId"] as? String,
                  requestID.range(of: "^[a-zA-Z0-9_-]{1,100}$", options: .regularExpression) != nil,
                  let draft = request["message"] as? String, draft.utf16.count <= 60000 else { return }
            let isSample = stageWeb?.url.flatMap { URLComponents(url: $0, resolvingAgainstBaseURL: false) }?.queryItems?.contains(where: { $0.name == "sample" && $0.value == "1" }) == true
            guard !isSample else { return }
            pendingWorkspaceChats[requestID] = request
            showChat()
            deliverWorkspaceChats()
            DispatchQueue.main.asyncAfter(deadline: .now() + 14) { [weak self] in self?.pendingWorkspaceChats.removeValue(forKey: requestID) }
        case "workspaceChatResult":
            guard message.webView === chatWeb, let requestID = body["requestId"] as? String,
                  pendingWorkspaceChats.removeValue(forKey: requestID) != nil else { return }
            sendWorkspaceChatResult(body)
        case "chatReady":
            guard message.webView === chatWeb else { return }
            chatPageReady = true
            chatWeb?.evaluateJavaScript("window.formeNative?.setVisible?.(\(chatWantsVisible ? "true" : "false"))", completionHandler: nil)
            // The window may already be attached before the WebView installs its bridge.
            sendContext()
            deliverWorkspaceChats()
            if chatWantsVisible, chat?.isKeyWindow == true { focusChatComposer() }
        case "detach": detachToEdge()
        case "enableWindowRecognition": enableWindowRecognition()
        case "captureContext":
            let requestedPurpose = body["purpose"] as? String ?? "collect"
            if requestedPurpose == "attachment-preview" {
                guard message.webView === chatWeb, let requestID = body["requestId"] as? String,
                      requestID.range(of: "^[a-zA-Z0-9_-]{1,100}$", options: .regularExpression) != nil else { return }
                guard let preview = AttachmentPreviewTarget(body) else {
                    sendContext(["error": "已识别的页面有变化，请确认当前页后重新读取。", "requestId": requestID])
                    return
                }
                captureContext(requestID: requestID, purpose: requestedPurpose, preview: preview)
                return
            }
            captureContext(requestID: body["requestId"] as? String,
                           purpose: ["conversation", "connect", "collect"].contains(requestedPurpose) ? requestedPurpose : "collect")
        case "openExternal":
            if let raw = body["url"] as? String, let url = URL(string: raw), ["http", "https"].contains(url.scheme?.lowercased() ?? "") { NSWorkspace.shared.open(url) }
        default: break
        }
    }

    private func trustedDemoStageURL(for webView: WKWebView) -> URL? {
        guard webView === stageWeb, !personalMode, let base = backendURL, let url = webView.url, let port = url.port,
              DialogOrigin.isTrusted(scheme: url.scheme ?? "", host: url.host ?? "", port: port, base: base) else { return nil }
        return url
    }

    func webView(_ webView: WKWebView, didCommit navigation: WKNavigation!) {
        guard let url = trustedDemoStageURL(for: webView) else { return }
        let login = url.path == "/login"
        if login { setDemoTagSignedIn(false) }
        setStageLoginLayout(login)
    }

    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        if webView === chatWeb {
            sendContext(); updateAccessibilityAppearance(); focusChatComposer()
        }
        if webView === stageWeb {
            // The demo server redirects this protected document to /login until the session is valid.
            if let url = trustedDemoStageURL(for: webView), url.path == surfaceURL("stage")?.path {
                setDemoTagSignedIn(true)
            }
            updateAccessibilityAppearance()
            let conversation = webView.url?.fragment == "chat" || webView.url.flatMap { URLComponents(url: $0, resolvingAgainstBaseURL: false) }?.queryItems?.contains(where: { $0.name == "surface" && $0.value == "workspace-chat" }) == true
            let signIn = webView.url?.path == "/login"
            stage?.title = signIn ? "登录 Folio" : conversation ? "Folio · 和 Tag 对话" : "Folio · 私人收藏馆"
            stageReady = !signIn
            if stageReady { showRequestedExhibition() }
            if let requested = pendingConversationURL, webView.url == requested {
                pendingConversationURL = nil
                setChatVisible(false)
            }
            if stage?.isKeyWindow == true { stage?.makeFirstResponder(webView) }
        }
    }

    func deliverWorkspaceChats() {
        guard chatPageReady, chatWantsVisible, let view = chatWeb else { return }
        for request in pendingWorkspaceChats.values {
            guard let data = try? JSONSerialization.data(withJSONObject: request),
                  let json = String(data: data, encoding: .utf8) else { continue }
            view.evaluateJavaScript("window.formeNative?.receiveWorkspaceChat?.(\(json)); undefined", completionHandler: nil)
        }
    }

    func sendWorkspaceChatResult(_ body: [String: Any]) {
        guard let requestID = body["requestId"] as? String else { return }
        var result: [String: Any] = ["requestId": requestID, "accepted": body["accepted"] as? Bool ?? false]
        if let error = body["error"] as? String { result["error"] = String(error.prefix(300)) }
        guard let data = try? JSONSerialization.data(withJSONObject: result),
              let json = String(data: data, encoding: .utf8) else { return }
        stageWeb?.evaluateJavaScript("window.formeNative?.workspaceChatResult?.(\(json))", completionHandler: nil)
    }

    func trustedDialogWindow(for webView: WKWebView, frame: WKFrameInfo) -> NSWindow? {
        guard !terminating, let base = backendURL,
              webView === chatWeb || webView === stageWeb,
              let currentURL = webView.url, let currentPort = currentURL.port,
              DialogOrigin.isTrusted(scheme: currentURL.scheme ?? "", host: currentURL.host ?? "", port: currentPort, base: base),
              DialogOrigin.isTrusted(scheme: frame.securityOrigin.protocol, host: frame.securityOrigin.host,
                                     port: frame.securityOrigin.port, base: base),
              let window = webView.window, window.isVisible, !window.isMiniaturized else { return nil }
        return window
    }

    func webView(_ webView: WKWebView, runJavaScriptAlertPanelWithMessage message: String,
                 initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping () -> Void) {
        guard let parent = trustedDialogWindow(for: webView, frame: frame) else { completionHandler(); return }
        let alert = NSAlert(); alert.messageText = "Folio"; alert.informativeText = message
        alert.alertStyle = .informational; alert.addButton(withTitle: "知道了")
        alert.beginSheetModal(for: parent) { _ in completionHandler() }
    }

    func webView(_ webView: WKWebView, runJavaScriptConfirmPanelWithMessage message: String,
                 initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping (Bool) -> Void) {
        guard let parent = trustedDialogWindow(for: webView, frame: frame) else { completionHandler(false); return }
        let alert = NSAlert(); alert.messageText = "Folio"; alert.informativeText = message
        alert.alertStyle = .informational; alert.addButton(withTitle: "确定")
        alert.addButton(withTitle: "取消").keyEquivalent = "\u{1b}"
        alert.beginSheetModal(for: parent) { response in completionHandler(response == .alertFirstButtonReturn) }
    }

    func webView(_ webView: WKWebView, runJavaScriptTextInputPanelWithPrompt prompt: String,
                 defaultText: String?, initiatedByFrame frame: WKFrameInfo,
                 completionHandler: @escaping (String?) -> Void) {
        guard let parent = trustedDialogWindow(for: webView, frame: frame) else { completionHandler(nil); return }
        let alert = NSAlert(); alert.messageText = "Folio"; alert.informativeText = prompt
        alert.alertStyle = .informational; alert.addButton(withTitle: "确定")
        alert.addButton(withTitle: "取消").keyEquivalent = "\u{1b}"

        let height: CGFloat = (defaultText?.count ?? 0) > 400 ? 240 : 160
        let scroll = NSScrollView(frame: NSRect(x: 0, y: 0, width: 400, height: height))
        scroll.hasVerticalScroller = true; scroll.autohidesScrollers = true
        scroll.borderType = .bezelBorder; scroll.drawsBackground = true
        scroll.backgroundColor = .textBackgroundColor
        let editor = NSTextView(frame: NSRect(origin: .zero, size: scroll.contentSize))
        editor.isRichText = false; editor.importsGraphics = false; editor.allowsUndo = true
        editor.font = .systemFont(ofSize: 14); editor.textColor = .textColor
        editor.backgroundColor = .textBackgroundColor
        editor.isVerticallyResizable = true; editor.isHorizontallyResizable = false
        editor.minSize = NSSize(width: 0, height: scroll.contentSize.height)
        editor.maxSize = NSSize(width: CGFloat.greatestFiniteMagnitude, height: CGFloat.greatestFiniteMagnitude)
        editor.autoresizingMask = [.width]
        editor.textContainerInset = NSSize(width: 8, height: 8)
        editor.textContainer?.containerSize = NSSize(width: scroll.contentSize.width, height: CGFloat.greatestFiniteMagnitude)
        editor.textContainer?.widthTracksTextView = true
        editor.isAutomaticQuoteSubstitutionEnabled = false
        editor.isAutomaticDashSubstitutionEnabled = false
        editor.isAutomaticSpellingCorrectionEnabled = false
        editor.string = defaultText ?? ""
        editor.setAccessibilityLabel("输入内容")
        scroll.documentView = editor; alert.accessoryView = scroll
        alert.window.initialFirstResponder = editor
        alert.beginSheetModal(for: parent) { response in
            completionHandler(response == .alertFirstButtonReturn ? editor.string : nil)
        }
        alert.window.makeFirstResponder(editor)
        editor.setSelectedRange(NSRange(location: 0, length: (editor.string as NSString).length))
    }

    func showRequestedExhibition() {
        if let id = pendingCollectionID,
           let data = try? JSONSerialization.data(withJSONObject: [id]),
           let json = String(data: data, encoding: .utf8) {
            pendingCollectionID = nil
            stageWeb?.evaluateJavaScript("Promise.resolve(window.formeNative?.refresh?.()).then(() => window.formeNative?.openCollection?.(\(json)[0]))", completionHandler: nil)
        }
        guard let id = pendingExhibitionID,
              let data = try? JSONSerialization.data(withJSONObject: [id]),
              let json = String(data: data, encoding: .utf8) else { return }
        pendingExhibitionID = nil
        stageWeb?.evaluateJavaScript("Promise.resolve(window.formeNative?.refresh?.()).then(() => window.formeNative?.openExhibition?.(\(json)[0]))", completionHandler: nil)
    }

    func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) {
        showWebFailure(webView, error: error)
    }

    func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) {
        showWebFailure(webView, error: error)
    }

    func showWebFailure(_ webView: WKWebView, error: Error) {
        if (error as NSError).code == NSURLErrorCancelled { return }
        if webView === stageWeb, pendingConversationURL != nil {
            pendingConversationURL = nil
            chatWeb?.evaluateJavaScript("window.formeNative?.handoffFailed?.()", completionHandler: nil)
        }
        let html = """
        <!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Folio · 私人收藏馆</title><body style="font:15px/1.8 -apple-system,sans-serif;padding:30px;background:#1b1d20;color:#ebedef"><h2 style="font-weight:500">收藏馆暂时没有打开。</h2><p>本机整理服务可能还在启动，或已经停止。收藏仍保存在这台电脑。</p><p>请从菜单栏退出应用后重新打开。如果仍未恢复，请联系维护者重新准备这个本机版本。</p></body></html>
        """
        webView.loadHTMLString(html, baseURL: nil)
    }

    func webView(_ webView: WKWebView, decidePolicyFor navigationAction: WKNavigationAction, decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
        guard let url = navigationAction.request.url, let base = backendURL else { decisionHandler(.cancel); return }
        if url.absoluteString == "about:blank" { decisionHandler(.allow); return }
        if url.scheme == base.scheme && url.host == base.host && url.port == base.port { decisionHandler(.allow); return }
        if navigationAction.navigationType == .linkActivated && ["http", "https"].contains(url.scheme?.lowercased() ?? "") { NSWorkspace.shared.open(url) }
        decisionHandler(.cancel)
    }

    func showPetMenu(event: NSEvent, view: NSView) {
        guard let menu = statusItem.menu?.copy() as? NSMenu else { return }
        NSMenu.popUpContextMenu(menu, with: event, for: view)
    }

    func showFailure(_ text: String) {
        let alert = NSAlert(); alert.messageText = "Folio"; alert.informativeText = text; alert.addButton(withTitle: "知道了")
        NSApp.activate(ignoringOtherApps: true); alert.runModal()
    }

    @objc func showAbout() {
        showFailure("Folio · Collect. Connect. Curate.\n\nTag 是陪你浏览、收藏和策展的小展签。这是本机开发版。桌宠与收藏馆使用系统原生窗口；收藏、性格和后台任务保存在这台电脑。\n\n拖到窗口后会关注这页，并在你打开对话时询问是否收藏。已获准的浏览器会提供当前页标题与地址；页面对话只参考这次关联的内容，只有你确认或明确说收藏时才入库。无法读取时可贴链接或正文。\n\n关闭对话不会停止整理；退出整个应用后，任务会在下次启动时恢复或提示重试。")
    }
    @objc func quit() { NSApp.terminate(nil) }
}

func writePetContactReview(to path: String, referencePath: String? = nil) throws {
    let width = 1100, height = 650
    guard let bitmap = NSBitmapImageRep(bitmapDataPlanes: nil, pixelsWide: width, pixelsHigh: height,
        bitsPerSample: 8, samplesPerPixel: 4, hasAlpha: true, isPlanar: false,
        colorSpaceName: .deviceRGB, bytesPerRow: 0, bitsPerPixel: 0),
          let graphics = NSGraphicsContext(bitmapImageRep: bitmap) else { return }
    let image = NSImage(size: NSSize(width: width, height: height)); image.addRepresentation(bitmap)
    NSGraphicsContext.saveGraphicsState(); NSGraphicsContext.current = graphics
    NSColor(srgbRed: 0.065, green: 0.07, blue: 0.08, alpha: 1).setFill()
    NSRect(x: 0, y: 0, width: width, height: height).fill()
    func label(_ value: String, x: CGFloat, y: CGFloat, size: CGFloat = 14) {
        (value as NSString).draw(at: NSPoint(x: x, y: y), withAttributes: [.font: NSFont.systemFont(ofSize: size),
            .foregroundColor: NSColor.white.withAlphaComponent(0.76)])
    }
    label("Folio · 正面平视展窗卡与四边吸附", x: 24, y: 610, size: 21)
    label("吸附标记 18×2pt · 展窗卡约 27×28pt · 点击范围仍为 72×84pt", x: 24, y: 582)
    if let referencePath = referencePath, let reference = NSImage(contentsOfFile: referencePath) {
        reference.draw(in: NSRect(x: 24, y: 425, width: 190, height: 106))
        reference.draw(in: NSRect(x: 70, y: 292, width: 95, height: 53))
    }
    if referencePath != nil {
        label("原始概念参考", x: 24, y: 543)
        label("参考折半尺寸", x: 65, y: 264)
    } else {
        label("Tag · 展窗卡", x: 24, y: 543, size: 18)
        label("原稿软圆壳 / 微凹深窗", x: 24, y: 510)
        label("两只暖白眼 / 双轴跟随", x: 24, y: 486)
        label("一条短线 / 暗红小方印", x: 24, y: 462)
        label("两眼默认同高 / 上下左右看", x: 24, y: 422)
        label("停住仍注视 / 隐藏时回正", x: 24, y: 398)
        label("跨窗口目标平滑接续", x: 24, y: 374)
    }
    func sample(edge: DockEdge?, x: CGFloat, y: CGFloat, scale: CGFloat, delivery: Bool = false) {
        let cell = NSRect(x: x, y: y, width: 180, height: scale == 1 ? 120 : 190)
        NSGraphicsContext.saveGraphicsState(); NSBezierPath(rect: cell).addClip()
        NSColor(srgbRed: 0.15, green: 0.48, blue: 0.69, alpha: 1).setFill(); cell.fill()
        let transform = NSAffineTransform()
        transform.translateX(by: cell.midX - 36 * scale, yBy: cell.midY - 42 * scale)
        transform.scale(by: scale); transform.concat()
        if let edge = edge {
            let normal = PetDockGeometry.inward(edge)
            let point = NSPoint(x: 36 - normal.dx * PetDockGeometry.standOff, y: 43 - normal.dy * PetDockGeometry.standOff)
            let outside: NSRect
            switch edge {
            case .top: outside = NSRect(x: -300, y: point.y, width: 600, height: 300)
            case .bottom: outside = NSRect(x: -300, y: point.y - 300, width: 600, height: 300)
            case .left: outside = NSRect(x: point.x - 300, y: -300, width: 300, height: 600)
            case .right: outside = NSRect(x: point.x, y: -300, width: 300, height: 600)
            }
            NSColor(srgbRed: 0.115, green: 0.115, blue: 0.132, alpha: 1).setFill(); outside.fill()
        }
        let view = PetView(frame: NSRect(origin: .zero, size: PetDockGeometry.size))
        view.drawContactPreview(edge: edge, hover: 0, delivery: delivery)
        NSGraphicsContext.restoreGraphicsState()
    }
    for (column, entry) in [("上边", DockEdge.top), ("右边", .right), ("下边", .bottom), ("左边", .left)].enumerated() {
        let x = CGFloat(244 + column * 210)
        label(entry.0 + " · 2 倍辅助", x: x + 40, y: 543)
        sample(edge: entry.1, x: x, y: 345, scale: 2)
        label("1 倍近似实际尺寸", x: x + 25, y: 312)
        sample(edge: entry.1, x: x, y: 180, scale: 1)
    }
    sample(edge: nil, x: 24, y: 35, scale: 1)
    label("自由拖动：完整角色", x: 24, y: 158)
    sample(edge: .bottom, x: 244, y: 35, scale: 1, delivery: true)
    label("真实完成提示的蓝点", x: 244, y: 158)
    label("普通四边预览没有蓝点。底座旋转，展窗卡与眼睛始终正向。", x: 455, y: 118)
    label("同一 PetView 离屏绘制；仅审形状与尺寸，不表示真实合成或性能。", x: 455, y: 88, size: 13)
    NSGraphicsContext.restoreGraphicsState()
    if let data = bitmap.representation(using: .png, properties: [:]) { try data.write(to: URL(fileURLWithPath: path)) }
    _ = image
}

func writePetGazeReview(to path: String) throws {
    let width = 1180, height = 850
    guard let bitmap = NSBitmapImageRep(bitmapDataPlanes: nil, pixelsWide: width, pixelsHigh: height,
        bitsPerSample: 8, samplesPerPixel: 4, hasAlpha: true, isPlanar: false,
        colorSpaceName: .deviceRGB, bytesPerRow: 0, bitsPerPixel: 0),
          let graphics = NSGraphicsContext(bitmapImageRep: bitmap) else { return }
    NSGraphicsContext.saveGraphicsState(); NSGraphicsContext.current = graphics
    NSColor(srgbRed: 0.067, green: 0.071, blue: 0.078, alpha: 1).setFill()
    NSRect(x: 0, y: 0, width: width, height: height).fill()
    func label(_ value: String, x: CGFloat, y: CGFloat, size: CGFloat = 15) {
        (value as NSString).draw(at: NSPoint(x: x, y: y), withAttributes: [
            .font: NSFont.systemFont(ofSize: size), .foregroundColor: NSColor.white.withAlphaComponent(0.85)])
    }
    label("Folio · Tag：正面平视展窗卡", x: 26, y: 800, size: 25)
    label("柔软立体倒角与原稿边距 · 两眼同高、正向 · 整组上下左右移动 · 主体约 27×28pt", x: 26, y: 768)
    func sample(_ title: String, column: Int, row: Int, edge: DockEdge?, offset: CGFloat, blink: CGFloat = 1) {
        let x = CGFloat(24 + column * 288), y = CGFloat(row == 0 ? 415 : 95)
        let cell = NSRect(x: x, y: y, width: 264, height: 288)
        NSColor(srgbRed: 0.15, green: 0.17, blue: 0.19, alpha: 1).setFill()
        NSBezierPath(roundedRect: cell, xRadius: 12, yRadius: 12).fill()
        label(title, x: x + 16, y: y + 254)
        func render(scale: CGFloat, center: NSPoint) {
            NSGraphicsContext.saveGraphicsState(); NSBezierPath(rect: cell).addClip()
            let transform = NSAffineTransform()
            transform.translateX(by: center.x - 36 * scale, yBy: center.y - 43 * scale)
            transform.scale(by: scale); transform.concat()
            let view = PetView(frame: NSRect(origin: .zero, size: PetDockGeometry.size))
            view.drawContactPreview(edge: edge, hover: 0, eyeOffset: offset, blink: blink)
            NSGraphicsContext.restoreGraphicsState()
        }
        render(scale: 4, center: NSPoint(x: cell.midX, y: cell.midY + 9))
        render(scale: 1, center: NSPoint(x: cell.midX, y: cell.minY + 44))
    }
    sample("正面 · 眼睛居中", column: 0, row: 0, edge: nil, offset: 0)
    sample("向左看 · 两眼一起移动", column: 1, row: 0, edge: nil, offset: -PetGaze.maximumOffset)
    sample("向右看 · 同组水平移动", column: 2, row: 0, edge: nil, offset: PetGaze.maximumOffset)
    sample("眨眼 · 中心高度不变", column: 3, row: 0, edge: nil, offset: 0, blink: 0.5)
    for (index, edge) in [DockEdge.top, .right, .bottom, .left].enumerated() {
        let title = ["上边吸附", "右边吸附", "下边吸附", "左边吸附"][index]
        sample(title, column: index, row: 1, edge: edge, offset: index % 2 == 0 ? -PetGaze.maximumOffset : PetGaze.maximumOffset)
    }
    label("每格上方为4倍形状对照，下方为1倍。此图由生产PetView离屏绘制；不是实际鼠标跟随或帧率证据。", x: 26, y: 42, size: 13)
    NSGraphicsContext.restoreGraphicsState()
    if let data = bitmap.representation(using: .png, properties: [:]) { try data.write(to: URL(fileURLWithPath: path)) }
}

func writePetAnchorReview(to path: String) throws {
    let width = 1280, height = 900
    guard let bitmap = NSBitmapImageRep(bitmapDataPlanes: nil, pixelsWide: width, pixelsHigh: height,
        bitsPerSample: 8, samplesPerPixel: 4, hasAlpha: true, isPlanar: false,
        colorSpaceName: .deviceRGB, bytesPerRow: 0, bitsPerPixel: 0),
          let graphics = NSGraphicsContext(bitmapImageRep: bitmap) else { return }
    NSGraphicsContext.saveGraphicsState(); NSGraphicsContext.current = graphics
    NSColor(srgbRed: 0.075, green: 0.08, blue: 0.085, alpha: 1).setFill()
    NSRect(x: 0, y: 0, width: width, height: height).fill()
    func label(_ text: String, x: CGFloat, y: CGFloat, light: Bool = false, size: CGFloat = 15) {
        (text as NSString).draw(at: NSPoint(x: x, y: y), withAttributes: [
            .font: NSFont.systemFont(ofSize: size),
            .foregroundColor: light ? NSColor.black.withAlphaComponent(0.68) : NSColor.white.withAlphaComponent(0.83)])
    }
    label("Folio · 独立浮卡与轻量吸附标记", x: 24, y: 850, size: 25)
    label("卡片与眼睛沿用正视稿 · 标记18×2pt、低透明暖灰 · 每格4倍与1倍", x: 24, y: 816)
    for row in 0...1 {
        let light = row == 1
        for (column, edge) in [DockEdge.top, .right, .bottom, .left].enumerated() {
            let cell = NSRect(x: 24 + column * 310, y: row == 0 ? 430 : 80, width: 292, height: 322)
            let surface = light ? NSColor(srgbRed: 0.95, green: 0.94, blue: 0.91, alpha: 1)
                                : NSColor(srgbRed: 0.145, green: 0.16, blue: 0.18, alpha: 1)
            surface.setFill(); NSBezierPath(roundedRect: cell, xRadius: 12, yRadius: 12).fill()
            label((light ? "浅色 · " : "深色 · ") + ["上边", "右边", "下边", "左边"][column],
                  x: cell.minX + 16, y: cell.maxY - 34, light: light)
            for scale: CGFloat in [4, 1] {
                let center = NSPoint(x: cell.midX, y: scale == 4 ? cell.midY + 12 : cell.minY + 52)
                NSGraphicsContext.saveGraphicsState(); NSBezierPath(rect: cell).addClip()
                let transform = NSAffineTransform()
                transform.translateX(by: center.x - 36 * scale, yBy: center.y - 43 * scale)
                transform.scale(by: scale); transform.concat()
                let view = PetView(frame: NSRect(origin: .zero, size: PetDockGeometry.size))
                view.drawContactPreview(edge: edge, hover: 0)
                NSGraphicsContext.restoreGraphicsState()
            }
        }
    }
    label("同一生产PetView离屏绘制；上方4倍用于审形，下方1倍近似实际尺寸。不是实时鼠标或点击穿透验收。", x: 24, y: 30, size: 13)
    NSGraphicsContext.restoreGraphicsState()
    if let data = bitmap.representation(using: .png, properties: [:]) { try data.write(to: URL(fileURLWithPath: path)) }
}

func writePetTwoAxisGazeReview(to path: String) throws {
    let width = 1240, height = 1120
    guard let bitmap = NSBitmapImageRep(bitmapDataPlanes: nil, pixelsWide: width, pixelsHigh: height,
        bitsPerSample: 8, samplesPerPixel: 4, hasAlpha: true, isPlanar: false,
        colorSpaceName: .deviceRGB, bytesPerRow: 0, bitsPerPixel: 0),
          let graphics = NSGraphicsContext(bitmapImageRep: bitmap) else { return }
    NSGraphicsContext.saveGraphicsState(); NSGraphicsContext.current = graphics
    NSColor(srgbRed: 0.075, green: 0.08, blue: 0.085, alpha: 1).setFill()
    NSRect(x: 0, y: 0, width: width, height: height).fill()
    func label(_ value: String, x: CGFloat, y: CGFloat, size: CGFloat = 15) {
        (value as NSString).draw(at: NSPoint(x: x, y: y), withAttributes: [
            .font: NSFont.systemFont(ofSize: size), .foregroundColor: NSColor.white.withAlphaComponent(0.86)])
    }
    label("Folio · Tag 的眼睛在展窗内圈跟随", x: 24, y: 1070, size: 25)
    label("展窗中央为中立眼位 · 内圈小幅上下左右跟随 · 两眼共用dx/dy · 每格6倍与1倍", x: 24, y: 1038)
    let titles = [["左上看", "向上看", "右上看"], ["向左看", "默认居中", "向右看"], ["左下看", "向下看", "右下看"]]
    for row in 0...2 {
        for column in 0...2 {
            let cell = NSRect(x: 24 + column * 404, y: 706 - row * 314, width: 384, height: 300)
            NSColor(srgbRed: 0.145, green: 0.16, blue: 0.18, alpha: 1).setFill()
            NSBezierPath(roundedRect: cell, xRadius: 12, yRadius: 12).fill()
            label(titles[row][column], x: cell.minX + 18, y: cell.maxY - 32)
            let dx = CGFloat(column - 1) * PetGaze.maximumOffset
            let dy = CGFloat(row - 1) * PetGaze.maximumVerticalOffset
            for scale: CGFloat in [6, 1] {
                let center = NSPoint(x: cell.midX, y: scale == 6 ? cell.midY + 20 : cell.minY + 36)
                NSGraphicsContext.saveGraphicsState(); NSBezierPath(rect: cell).addClip()
                let transform = NSAffineTransform()
                transform.translateX(by: center.x - 36 * scale, yBy: center.y - 43 * scale)
                transform.scale(by: scale); transform.concat()
                let view = PetView(frame: NSRect(origin: .zero, size: PetDockGeometry.size))
                view.drawContactPreview(edge: nil, hover: 0, eyeOffset: dx, eyeVerticalOffset: dy)
                NSGraphicsContext.restoreGraphicsState()
            }
        }
    }
    label("由生产壳图与双轴眼层离屏绘制；只审形状与范围，不是实际鼠标跟随或点击穿透证据。", x: 24, y: 28, size: 13)
    NSGraphicsContext.restoreGraphicsState()
    if let data = bitmap.representation(using: .png, properties: [:]) { try data.write(to: URL(fileURLWithPath: path)) }
}

func writePetWindowIslandReview(to path: String, light: Bool, approach: Bool = false) throws {
    let width = 1280, height = 860
    guard let bitmap = NSBitmapImageRep(bitmapDataPlanes: nil, pixelsWide: width, pixelsHigh: height,
        bitsPerSample: 8, samplesPerPixel: 4, hasAlpha: true, isPlanar: false,
        colorSpaceName: .deviceRGB, bytesPerRow: 0, bitsPerPixel: 0),
          let graphics = NSGraphicsContext(bitmapImageRep: bitmap) else { return }
    NSGraphicsContext.saveGraphicsState(); NSGraphicsContext.current = graphics
    let background = light ? NSColor(srgbRed: 0.94, green: 0.93, blue: 0.90, alpha: 1)
                           : NSColor(srgbRed: 0.075, green: 0.08, blue: 0.09, alpha: 1)
    background.setFill(); NSRect(x: 0, y: 0, width: width, height: height).fill()
    func label(_ value: String, x: CGFloat, y: CGFloat, size: CGFloat = 15) {
        (value as NSString).draw(at: NSPoint(x: x, y: y), withAttributes: [
            .font: NSFont.systemFont(ofSize: size),
            .foregroundColor: light ? NSColor.black.withAlphaComponent(0.77) : NSColor.white.withAlphaComponent(0.85)])
    }
    label(approach ? "Folio · 靠近窗口边的黏连预显" : "Folio · 石墨软壳与更大黏连弧", x: 24, y: 810, size: 25)
    label(approach ? "当前卡体边缘距真实窗口边12pt / 5pt · 15pt内连续渐入 · 只画预显，不改变附着身份 · 4倍与1倍"
        : "四边均在窗口内；两个8.6×10.6pt同壳黏连弧，无底板。按住与拖动显示 ><。每格5倍与1倍。", x: 24, y: 776)
    for row in 0...1 {
        for (column, edge) in [DockEdge.top, .right, .bottom, .left].enumerated() {
            let cell = NSRect(x: 24 + column * 310, y: 418 - row * 344, width: 292, height: 330)
            let outside = light ? NSColor(srgbRed: 0.98, green: 0.975, blue: 0.96, alpha: 1)
                                : NSColor(srgbRed: 0.10, green: 0.11, blue: 0.13, alpha: 1)
            let windowColor = light ? NSColor(srgbRed: 0.86, green: 0.86, blue: 0.85, alpha: 1)
                                    : NSColor(srgbRed: 0.20, green: 0.21, blue: 0.23, alpha: 1)
            outside.setFill(); NSBezierPath(roundedRect: cell, xRadius: 10, yRadius: 10).fill()
            let title = approach ? "距边\(row == 0 ? 12 : 5)pt · " + ["上边", "右边", "下边", "左边"][column]
                : row == 0 ? "窗口内附 · " + ["上边", "右边", "下边", "左边"][column]
                : ["自由居中", "自由内圈跟随", "按住 ><（眨眼不覆盖）", "拖动 ><"][column]
            label(title, x: cell.minX + 12, y: cell.maxY - 28, size: 13)
            for scale: CGFloat in [approach ? 4 : 5, 1] {
                let center = NSPoint(x: cell.midX, y: scale > 1 ? cell.minY + 190 : cell.minY + 35)
                let area = scale > 1 ? NSRect(x: cell.minX + 4, y: cell.minY + 78, width: cell.width - 8, height: 222)
                                      : NSRect(x: cell.minX + 4, y: cell.minY, width: cell.width - 8, height: 76)
                NSGraphicsContext.saveGraphicsState(); NSBezierPath(rect: area).addClip()
                if row == 0 || approach {
                    let normal = PetDockGeometry.inward(edge)
                    let rest = PetMotion.pose(edge: nil, hover: 0, press: approach ? 1 : 0, drag: .zero,
                        releaseProgress: 1, blinkProgress: 1, reducedMotion: false)
                    let base = PetMotion.artwork(contact: nil, frame: .zero, pose: rest)
                    let body = PetInputHitRegion.bodyBounds(base, in: .zero)
                    let half = (abs(normal.dx) * body.width + abs(normal.dy) * body.height) / 2
                    let distance = approach ? half - 0.12 + (row == 0 ? 12 : 5) : PetDockGeometry.standOff(normal: normal, isWindow: true)
                    let face = approach ? base.face : PetDockGeometry.center
                    let contact = NSPoint(x: center.x + (face.x - 36) * scale - normal.dx * distance * scale,
                                          y: center.y + (face.y - 43) * scale - normal.dy * distance * scale)
                    var inside = area
                    switch edge {
                    case .top: inside.size.height = max(0, min(area.maxY, contact.y) - area.minY)
                    case .bottom: inside.origin.y = max(area.minY, contact.y); inside.size.height = max(0, area.maxY - inside.minY)
                    case .left: inside.origin.x = max(area.minX, contact.x); inside.size.width = max(0, area.maxX - inside.minX)
                    case .right: inside.size.width = max(0, min(area.maxX, contact.x) - area.minX)
                    }
                    windowColor.setFill(); inside.fill()
                }
                let transform = NSAffineTransform()
                transform.translateX(by: center.x - 36 * scale, yBy: center.y - 43 * scale)
                transform.scale(by: scale); transform.concat()
                let view = PetView(frame: NSRect(origin: .zero, size: PetDockGeometry.size))
                view.drawContactPreview(edge: row == 0 || approach ? edge : nil, hover: 0,
                    eyeOffset: !approach && row == 1 && column == 1 ? PetGaze.maximumOffset : 0,
                    blink: !approach && row == 1 && column == 2 ? 0.5 : 1, isWindow: row == 0 || approach,
                    held: approach || (row == 1 && column == 2), dragged: approach || (row == 1 && column == 3),
                    previewGap: approach ? (row == 0 ? 12 : 5) : nil)
                NSGraphicsContext.restoreGraphicsState()
            }
        }
    }
    label("生产PetView与原壳图离屏实绘；色块示意窗口内外。此图不证明真实拖拽或帧率。", x: 24, y: 24, size: 13)
    NSGraphicsContext.restoreGraphicsState()
    if let data = bitmap.representation(using: .png, properties: [:]) { try data.write(to: URL(fileURLWithPath: path)) }
}

func writePetHeldSequenceReview(to path: String) throws {
    let width = 1600, height = 460
    guard let bitmap = NSBitmapImageRep(bitmapDataPlanes: nil, pixelsWide: width, pixelsHigh: height,
        bitsPerSample: 8, samplesPerPixel: 4, hasAlpha: true, isPlanar: false,
        colorSpaceName: .deviceRGB, bytesPerRow: 0, bitsPerPixel: 0),
          let graphics = NSGraphicsContext(bitmapImageRep: bitmap) else { return }
    NSGraphicsContext.saveGraphicsState(); NSGraphicsContext.current = graphics
    NSColor(srgbRed: 0.09, green: 0.10, blue: 0.11, alpha: 1).setFill()
    NSRect(x: 0, y: 0, width: width, height: height).fill()
    func label(_ value: String, at point: NSPoint, size: CGFloat = 14) {
        (value as NSString).draw(at: point, withAttributes: [.font: NSFont.systemFont(ofSize: size),
            .foregroundColor: NSColor.white.withAlphaComponent(0.85)])
    }
    label("Folio · 更清楚的眼睛与连续 >< 表情", at: NSPoint(x: 24, y: 410), size: 25)
    label("同一90ms上升 / 160ms释放进度；越过拖动阈值不跳变；恢复过程不眨眼。", at: NSPoint(x: 24, y: 378))
    let titles = ["按下 0ms", "按住 45ms", "开始拖动 45ms", "拖住 90ms", "松手 0ms", "松手 80ms", "松手 160ms"]
    let amounts: [CGFloat] = [0, 0.5, 0.5, 1, 1, 0.5, 0]
    for index in titles.indices {
        let cell = NSRect(x: 20 + index * 224, y: 60, width: 212, height: 292)
        NSColor(srgbRed: 0.15, green: 0.16, blue: 0.18, alpha: 1).setFill()
        NSBezierPath(roundedRect: cell, xRadius: 10, yRadius: 10).fill()
        label(titles[index], at: NSPoint(x: cell.minX + 12, y: cell.maxY - 30), size: 13)
        for scale: CGFloat in [5, 1] {
            let center = NSPoint(x: cell.midX, y: scale == 5 ? cell.midY + 20 : cell.minY + 32)
            NSGraphicsContext.saveGraphicsState(); NSBezierPath(rect: cell).addClip()
            let transform = NSAffineTransform()
            transform.translateX(by: center.x - 36 * scale, yBy: center.y - 43 * scale)
            transform.scale(by: scale); transform.concat()
            let view = PetView(frame: NSRect(origin: .zero, size: PetDockGeometry.size))
            view.drawContactPreview(edge: nil, hover: 0, eyeOffset: PetGaze.maximumOffset,
                blink: index >= 4 && index <= 5 ? 0.5 : 1,
                held: index <= 3, dragged: index == 2 || index == 3, pressProgress: amounts[index])
            NSGraphicsContext.restoreGraphicsState()
        }
    }
    label("生产组件离屏采样，仅验证绘制与插值；真实鼠标拖按另行验收。", at: NSPoint(x: 24, y: 22), size: 13)
    NSGraphicsContext.restoreGraphicsState()
    if let data = bitmap.representation(using: .png, properties: [:]) { try data.write(to: URL(fileURLWithPath: path)) }
}

if let approachIndex = CommandLine.arguments.firstIndex(of: "--pet-drag-adhesion-review"), approachIndex + 1 < CommandLine.arguments.count {
    try writePetWindowIslandReview(to: CommandLine.arguments[approachIndex + 1], light: CommandLine.arguments.contains("--light"), approach: true)
    print("FOLIO production early adhesion review rendered without input simulation")
} else if let heldIndex = CommandLine.arguments.firstIndex(of: "--pet-held-sequence-review"), heldIndex + 1 < CommandLine.arguments.count {
    try writePetHeldSequenceReview(to: CommandLine.arguments[heldIndex + 1])
    print("FOLIO held expression drawing sequence rendered without synthesizing input")
} else if let islandIndex = CommandLine.arguments.firstIndex(of: "--pet-window-island-review"), islandIndex + 1 < CommandLine.arguments.count {
    try writePetWindowIslandReview(to: CommandLine.arguments[islandIndex + 1], light: CommandLine.arguments.contains("--light"))
    print("FOLIO direct inward attachment and held-expression review rendered without creating windows")
} else if let twoAxisIndex = CommandLine.arguments.firstIndex(of: "--pet-gaze-2d-review"), twoAxisIndex + 1 < CommandLine.arguments.count {
    try writePetTwoAxisGazeReview(to: CommandLine.arguments[twoAxisIndex + 1])
    print("FOLIO two-axis gaze review rendered from production resources without creating windows")
} else if let anchorIndex = CommandLine.arguments.firstIndex(of: "--pet-anchor-review"), anchorIndex + 1 < CommandLine.arguments.count {
    try writePetAnchorReview(to: CommandLine.arguments[anchorIndex + 1])
    print("FOLIO independent-card contact review rendered on light/dark backgrounds without creating windows")
} else if let gazeIndex = CommandLine.arguments.firstIndex(of: "--pet-gaze-review"), gazeIndex + 1 < CommandLine.arguments.count {
    try writePetGazeReview(to: CommandLine.arguments[gazeIndex + 1])
    print("FOLIO approved shell plus dynamic gaze review rendered from production resources without creating windows")
} else if let reviewIndex = CommandLine.arguments.firstIndex(of: "--pet-render-review"), reviewIndex + 1 < CommandLine.arguments.count {
    let referencePath = reviewIndex + 2 < CommandLine.arguments.count ? CommandLine.arguments[reviewIndex + 2] : nil
    try writePetContactReview(to: CommandLine.arguments[reviewIndex + 1], referencePath: referencePath)
    print("FORME pet contact review rendered without creating windows")
} else if CommandLine.arguments.contains("--geometry-test") {
    let screen = NSRect(x: 100, y: 50, width: 1200, height: 800)
    let size = NSSize(width: 72, height: 84)
    for (point, expected) in [(NSPoint(x: 95, y: 400), DockEdge.left), (NSPoint(x: 1270, y: 400), .right), (NSPoint(x: 600, y: 820), .top), (NSPoint(x: 600, y: 40), .bottom)] {
        let result = Docking.origin(for: NSRect(origin: point, size: size), in: screen)
        precondition(result.1 == expected)
        let chat = Docking.chatFrame(near: NSRect(origin: result.0, size: size), screen: screen, size: NSSize(width: 390, height: 570))
        precondition(screen.contains(chat))
    }
    let chatBounds = NSRect(x: 0, y: 0, width: 390, height: 570)
    let titleRegion: [String: Any] = ["left": 48.0, "right": 283.0, "top": 0.0, "bottom": 48.0]
    let grip = ChatDragView.region(titleRegion, in: chatBounds)
    precondition(grip == NSRect(x: 48, y: 522, width: 235, height: 48))
    precondition(grip?.contains(NSPoint(x: 280, y: 545)) == true)
    precondition(grip?.contains(NSPoint(x: 297, y: 545)) == false)
    precondition(grip?.contains(NSPoint(x: 110, y: 500)) == false)
    precondition(ChatDragView.region(["left": 0.0, "right": 300.0, "top": 10.0, "bottom": 300.0], in: chatBounds) == nil)
    let secondScreen = NSRect(x: -1200, y: -120, width: 1200, height: 740)
    let freelyPlaced = chatBounds.offsetBy(dx: -800, dy: -85)
    precondition(Docking.constrainedChatFrame(freelyPlaced, in: secondScreen) == freelyPlaced)
    let nearEdge = Docking.constrainedChatFrame(freelyPlaced.offsetBy(dx: -420, dy: 1000), in: secondScreen)
    precondition(nearEdge.minX == secondScreen.minX + 8 && nearEdge.maxY == secondScreen.maxY - 8)
    let compactScreen = NSRect(x: 0, y: 28, width: 360, height: 492)
    let compactChat = Docking.constrainedChatFrame(chatBounds, in: compactScreen)
    precondition(compactChat == compactScreen.insetBy(dx: 8, dy: 8))
    // A maximized Chrome title bar and its top-right interior were swallowed by
    // the former 48-point desktop-edge band. Only the explicit outer 8 points dock.
    for point in [NSPoint(x: screen.midX, y: screen.maxY - 24),
                  NSPoint(x: screen.maxX - 20, y: screen.maxY - 20),
                  NSPoint(x: screen.maxX - 24, y: screen.midY)] {
        precondition(!Docking.isScreenDockGesture(at: point, in: screen))
    }
    for point in [NSPoint(x: screen.minX + 3, y: screen.midY),
                  NSPoint(x: screen.maxX - 8, y: screen.midY),
                  NSPoint(x: screen.midX, y: screen.maxY - 2),
                  NSPoint(x: screen.midX, y: screen.minY + 4)] {
        precondition(Docking.isScreenDockGesture(at: point, in: screen))
    }
    let edgeWindow = AttachedWindow(id: 301, pid: 901, appName: "Edge", bundleID: nil, title: "", cgBounds:
        CGRect(x: screen.minX, y: 900 - screen.maxY, width: screen.width, height: screen.height))
    for point in [NSPoint(x: screen.minX + 3, y: screen.midY), NSPoint(x: screen.maxX - 3, y: screen.midY),
                  NSPoint(x: screen.midX, y: screen.maxY - 3), NSPoint(x: screen.midX, y: screen.minY + 3)] {
        let target = WindowProbe.target(at: point, windows: [edgeWindow], primaryTop: 900)
        precondition(target?.id == 301)
        precondition(!Docking.isScreenDockGesture(at: point, in: screen, hasWindowTarget: target != nil))
        precondition(WindowProbe.target(at: point, windows: [], primaryTop: 900) == nil)
        precondition(Docking.isScreenDockGesture(at: point, in: screen, hasWindowTarget: false))
    }
    precondition(WindowValue.pid(NSNumber(value: Int64(12345))) == 12345)
    precondition(WindowValue.windowID(NSNumber(value: UInt64(4294967295))) == UInt32.max)
    precondition(WindowValue.pid(NSNumber(value: -1)) == nil)
    precondition(WindowValue.windowID(NSNumber(value: true)) == nil)
    let rawBounds: [String: Any] = ["X": NSNumber(value: -640), "Y": NSNumber(value: -180),
                                   "Width": NSNumber(value: 600), "Height": NSNumber(value: 400)]
    let bounds = WindowValue.bounds(rawBounds)!
    let converted = WindowValue.appKitFrame(bounds, primaryTop: 900)
    precondition(converted == NSRect(x: -640, y: 680, width: 600, height: 400))
    precondition(900 - converted.maxY == bounds.minY)
    let firstAX = AttachedWindow(id: 0, pid: 12345, appName: "Test", bundleID: nil, title: "", cgBounds: bounds)
    let otherAX = AttachedWindow(id: 0, pid: 12345, appName: "Test", bundleID: nil, title: "", cgBounds: bounds)
    precondition(firstAX.token != otherAX.token)
    var movedAX = firstAX; movedAX.cgBounds.origin.x += 20
    precondition(movedAX.token == firstAX.token)
    struct BodyFixture {
        let traits: BrowserAXTraits
        let children: [Int]
        let text: String
    }
    func bodyNode(_ role: String, _ subrole: String = "", editable: Bool = false, children: [Int] = [], text: String = "") -> BodyFixture {
        BodyFixture(traits: BrowserAXTraits(role: role, subrole: subrole, editable: editable), children: children, text: text)
    }
    let bodyTree = [
        bodyNode("AXWebArea", children: [1, 2, 3, 4]),
        bodyNode("AXGroup", "AXLandmarkNavigation", children: [5]),
        bodyNode("AXGroup", "AXLandmarkMain", children: [6, 7, 8, 9, 10]),
        bodyNode("AXGroup", "AXLandmarkContentInfo", children: [11]),
        bodyNode("AXGroup", "AXLandmarkComplementary", children: [12]),
        bodyNode("AXStaticText", text: "NAV must not appear"),
        bodyNode("AXStaticText", text: "Article paragraph"),
        bodyNode("AXLink", children: [13]),
        bodyNode("AXGroup", "AXLandmarkForm", children: [14]),
        bodyNode("AXTextArea", editable: true, text: "SECRET INPUT"),
        bodyNode("AXWebArea", children: [15]),
        bodyNode("AXStaticText", text: "FOOTER must not appear"),
        bodyNode("AXStaticText", text: "ASIDE must not appear"),
        bodyNode("AXStaticText", text: "Array.map() teaching link"),
        bodyNode("AXStaticText", text: "FORM must not appear"),
        bodyNode("AXStaticText", text: "OTHER FRAME must not appear")
    ]
    var bodyVisits = 0
    let bodyRoot = BrowserAXBodyPolicy.preferredRoot(area: 0, traits: { bodyTree[$0].traits }, children: { bodyTree[$0].children },
        visit: { bodyVisits += 1; return bodyVisits <= 1800 })
    precondition(bodyRoot == 2 && bodyVisits < 10)
    var discoveryBudget = 3
    let boundedRoot = BrowserAXBodyPolicy.preferredRoot(area: 0, traits: { bodyTree[$0].traits }, children: { bodyTree[$0].children },
        visit: { guard discoveryBudget > 0 else { return false }; discoveryBudget -= 1; return true })
    precondition(boundedRoot == 0 && discoveryBudget == 0)
    var bodyStack = [bodyRoot], bodyFragments: [String] = []
    while let index = bodyStack.popLast() {
        let node = bodyTree[index]
        guard !BrowserAXBodyPolicy.skips(node.traits), node.traits.role != "AXWebArea" else { continue }
        if node.traits.role == "AXStaticText" { bodyFragments.append(node.text) }
        else { bodyStack.append(contentsOf: node.children.reversed()) }
    }
    precondition(bodyFragments == ["Article paragraph", "Array.map() teaching link"])
    let articleOnly = [bodyNode("AXWebArea", children: [1]), bodyNode("AXGroup", "AXDocumentArticle", children: [2]),
        bodyNode("AXStaticText", text: "Only article")]
    precondition(BrowserAXBodyPolicy.preferredRoot(area: 0, traits: { articleOnly[$0].traits }, children: { articleOnly[$0].children }, visit: { true }) == 1)
    precondition(BrowserAXBodyPolicy.preferredRoot(area: 0, traits: { _ in BrowserAXTraits(role: "AXWebArea", subrole: "", editable: false) }, children: { _ in [] }, visit: { true }) == 0)
    for landmark in ["AXLandmarkBanner", "AXLandmarkNavigation", "AXLandmarkContentInfo", "AXLandmarkComplementary", "AXLandmarkSearch", "AXLandmarkForm"] {
        precondition(BrowserAXBodyPolicy.skips(BrowserAXTraits(role: "AXGroup", subrole: landmark, editable: false)))
    }
    precondition(!BrowserAXBodyPolicy.skips(BrowserAXTraits(role: "AXLink", subrole: "", editable: false)))
    print("FOLIO AX body: main/article subroles, filtered fallback, editable/forms/navigation/aside/footer exclusion, nested frame isolation and teaching-link text passed")
    let dialogBase = URL(string: "http://127.0.0.1:48123")!
    precondition(DialogOrigin.isTrusted(scheme: "http", host: "127.0.0.1", port: 48123, base: dialogBase))
    for (scheme, host, port) in [("https", "127.0.0.1", 48123), ("http", "localhost", 48123),
                                 ("http", "example.com", 48123), ("http", "127.0.0.1", 48124)] {
        precondition(!DialogOrigin.isTrusted(scheme: scheme, host: host, port: port, base: dialogBase))
    }
    let restingChat = NSRect(x: 200, y: 160, width: 390, height: 570)
    let tuckedChat = restingChat.offsetBy(dx: 0, dy: -8)
    let opening = ChatTransition(fromFrame: tuckedChat, toFrame: restingChat, fromAlpha: 0, toAlpha: 1,
                                 startedAt: 100, duration: 0.2, showing: true)
    let initial = opening.value(at: 100), partial = opening.value(at: 100.08), opened = opening.value(at: 100.2)
    precondition(initial.frame == tuckedChat && initial.alpha == 0 && !initial.complete)
    precondition(partial.alpha > 0 && partial.alpha < 1 && !partial.complete)
    precondition(partial.frame.minY > tuckedChat.minY && partial.frame.minY < restingChat.minY)
    precondition(opened.frame == restingChat && opened.alpha == 1 && opened.complete)
    let reversing = ChatTransition(fromFrame: partial.frame, toFrame: tuckedChat, fromAlpha: partial.alpha, toAlpha: 0,
                                   startedAt: 100.08, duration: 0.2, showing: false)
    let reversalStart = reversing.value(at: 100.08), closed = reversing.value(at: 100.28)
    precondition(reversalStart.frame == partial.frame && reversalStart.alpha == partial.alpha)
    precondition(closed.frame == tuckedChat && closed.alpha == 0 && closed.complete)
    let reducedMotion = ChatTransition(fromFrame: tuckedChat, toFrame: restingChat, fromAlpha: 0, toAlpha: 1,
                                       startedAt: 100, duration: 0, showing: true).value(at: 100)
    precondition(reducedMotion.frame == restingChat && reducedMotion.alpha == 1 && reducedMotion.complete)
    let petRest = PetMotion.pose(edge: .right, hover: 0, press: 0, drag: .zero, releaseProgress: 1, blinkProgress: 1, reducedMotion: false)
    precondition(petRest.translation == .zero && petRest.scale == NSSize(width: 1, height: 1) && petRest.tilt == 0)
    for (point, edge) in [(NSPoint(x: 95, y: 400), DockEdge.left), (NSPoint(x: 1270, y: 400), .right),
                          (NSPoint(x: 600, y: 820), .top), (NSPoint(x: 600, y: 40), .bottom)] {
        let parked = Docking.origin(for: NSRect(origin: point, size: size), in: screen).0
        let peek = PetMotion.pose(edge: edge, hover: 1, press: 0, drag: .zero, releaseProgress: 1, blinkProgress: 1, reducedMotion: false)
        switch edge {
        case .left: precondition(peek.translation.x > 0)
        case .right: precondition(peek.translation.x < 0)
        case .top: precondition(peek.translation.y < 0)
        case .bottom: precondition(peek.translation.y > 0)
        }
        let visibleInPet = screen.offsetBy(dx: -parked.x, dy: -parked.y).intersection(NSRect(origin: .zero, size: size))
        let badge = PetMotion.deliveryAnchor(edge: edge)
        precondition(visibleInPet.contains(NSRect(x: badge.x - 3, y: badge.y - 3, width: 6, height: 6)))
        precondition(abs(peek.translation.x) <= 5 && abs(peek.translation.y) <= 5)
    }
    let pressedPet = PetMotion.pose(edge: nil, hover: 0, press: 1, drag: .zero, releaseProgress: 1, blinkProgress: 1, reducedMotion: false)
    precondition(pressedPet.scale.width > 1 && pressedPet.scale.height < 1)
    let draggedPet = PetMotion.pose(edge: .right, hover: 1, press: 1, drag: CGVector(dx: 1, dy: 0), releaseProgress: 1, blinkProgress: 1, reducedMotion: false)
    precondition(draggedPet.scale.width > 1 && draggedPet.scale.height < 1 && abs(draggedPet.tilt) < 0.06)
    let blinkPet = PetMotion.pose(edge: nil, hover: 0, press: 0, drag: .zero, releaseProgress: 1, blinkProgress: 0.5, reducedMotion: false)
    precondition(blinkPet.eyeOpenness < 0.01 && petRest.eyeOpenness > 0.99)
    precondition(PetMotion.release(at: 0) == 0 && PetMotion.release(at: 1) == 0)
    let quietPet = PetMotion.pose(edge: .left, hover: 1, press: 1, drag: CGVector(dx: 1, dy: 1), releaseProgress: 0.2, blinkProgress: 0.5, reducedMotion: true)
    precondition(quietPet.translation == .zero && quietPet.scale == NSSize(width: 1, height: 1) && quietPet.tilt == 0 && quietPet.eyeOpenness == 1)
    let petHover = PetScalarTransition(from: 0, to: 1, startedAt: 10, duration: 0.18)
    let petHalfHover = petHover.value(at: 10.06).amount
    let petHoverReversal = PetScalarTransition(from: petHalfHover, to: 0, startedAt: 10.06, duration: 0.18)
    precondition(petHoverReversal.value(at: 10.06).amount == petHalfHover)
    precondition(petHoverReversal.value(at: 10.24).amount == 0 && petHoverReversal.value(at: 10.24).complete)
    func points(_ contour: PetContour) -> [NSPoint] {
        [contour.start] + contour.curves.flatMap { [$0.first, $0.second, $0.end] }
    }
    func near(_ a: CGFloat, _ b: CGFloat) -> Bool { abs(a - b) < 0.00001 }
    func same(_ a: NSPoint, _ b: NSPoint) -> Bool { near(a.x, b.x) && near(a.y, b.y) }
    let freePoints = points(PetMotion.contour(contact: nil, frame: .zero, amount: 0, pose: draggedPet))
    for edge in [DockEdge.top, .right, .bottom, .left] {
        let placement = PetDockGeometry.screen(edge: edge, near: NSPoint(x: screen.midX, y: screen.midY), in: screen)
        precondition(placement.frame.size == size && !placement.contact.isWindow)
        let contact = placement.contact, normal = PetDockGeometry.inward(edge)
        precondition(contact.normal.dx == normal.dx && contact.normal.dy == normal.dy)
        switch edge {
        case .top: precondition(contact.point.y == screen.maxY)
        case .right: precondition(contact.point.x == screen.maxX)
        case .bottom: precondition(contact.point.y == screen.minY)
        case .left: precondition(contact.point.x == screen.minX)
        }
        let startPoints = points(PetMotion.contour(contact: contact, frame: placement.frame, amount: 0, pose: draggedPet))
        precondition(zip(startPoints, freePoints).allSatisfy { same($0, $1) })
        let rest = PetMotion.contour(contact: contact, frame: placement.frame, amount: 1, pose: petRest)
        let origin = NSPoint(x: contact.point.x - placement.frame.minX, y: contact.point.y - placement.frame.minY)
        let tangent = CGVector(dx: normal.dy, dy: -normal.dx)
        let canonical = points(PetMotion.contactContour)
        let expected = canonical.map { NSPoint(x: origin.x + tangent.dx * $0.x + normal.dx * $0.y,
                                               y: origin.y + tangent.dy * $0.x + normal.dy * $0.y) }
        precondition(zip(points(rest), expected).allSatisfy { same($0, $1) })
        let offsets = points(rest).map { ($0.x - origin.x) * normal.dx + ($0.y - origin.y) * normal.dy }
        precondition(near(offsets.min()!, 0.2) && near(offsets.max()!, 2.2))
        for point in points(rest) {
            let world = NSPoint(x: point.x + placement.frame.minX, y: point.y + placement.frame.minY)
            precondition(world.x >= screen.minX - 0.001 && world.x <= screen.maxX + 0.001)
            precondition(world.y >= screen.minY - 0.001 && world.y <= screen.maxY + 0.001)
        }
        precondition(same(PetMotion.faceCenter(contact: contact, frame: placement.frame, amount: 1, pose: petRest), PetDockGeometry.center))
    }
    // The only contact surface is a thin closed capsule, without any surrounding cradle.
    let marker = PetMotion.contactContour
    precondition(marker.curves.count == 8)
    for index in marker.curves.indices {
        let current = marker.curves[index], next = marker.curves[(index + 1) % marker.curves.count]
        let incoming = NSPoint(x: 3 * (current.end.x - current.second.x), y: 3 * (current.end.y - current.second.y))
        let outgoing = NSPoint(x: 3 * (next.first.x - current.end.x), y: 3 * (next.first.y - current.end.y))
        precondition(same(incoming, outgoing))
    }
    func cubicPoint(start: NSPoint, curve: PetCurve, at t: CGFloat) -> NSPoint {
        let u = 1 - t
        return NSPoint(x: u * u * u * start.x + 3 * u * u * t * curve.first.x + 3 * u * t * t * curve.second.x + t * t * t * curve.end.x,
                       y: u * u * u * start.y + 3 * u * u * t * curve.first.y + 3 * u * t * t * curve.second.y + t * t * t * curve.end.y)
    }
    func cubicDerivatives(start: NSPoint, curve: PetCurve, at t: CGFloat) -> (NSPoint, NSPoint) {
        let u = 1 - t
        let first = NSPoint(x: 3 * u * u * (curve.first.x - start.x) + 6 * u * t * (curve.second.x - curve.first.x) + 3 * t * t * (curve.end.x - curve.second.x),
                            y: 3 * u * u * (curve.first.y - start.y) + 6 * u * t * (curve.second.y - curve.first.y) + 3 * t * t * (curve.end.y - curve.second.y))
        let second = NSPoint(x: 6 * u * (curve.second.x - 2 * curve.first.x + start.x) + 6 * t * (curve.end.x - 2 * curve.second.x + curve.first.x),
                             y: 6 * u * (curve.second.y - 2 * curve.first.y + start.y) + 6 * t * (curve.end.y - 2 * curve.second.y + curve.first.y))
        return (first, second)
    }
    let markerStarts = [marker.start] + marker.curves.dropLast().map { $0.end }
    let mirroredSegments = [1, 0, 7, 6, 5, 4, 3, 2]
    for index in marker.curves.indices {
        for sample in 0...64 {
            let t = CGFloat(sample) / 64
            let a = cubicPoint(start: markerStarts[index], curve: marker.curves[index], at: t)
            let other = mirroredSegments[index]
            let b = cubicPoint(start: markerStarts[other], curve: marker.curves[other], at: 1 - t)
            precondition(near(a.x, -b.x) && near(a.y, b.y))
            precondition(a.x >= -9.000001 && a.x <= 9.000001 && a.y >= 0.199999 && a.y <= 2.200001)
            let derivatives = cubicDerivatives(start: markerStarts[index], curve: marker.curves[index], at: t)
            let curvature = derivatives.0.x * derivatives.1.y - derivatives.0.y * derivatives.1.x
            if [0, 1, 4, 5].contains(index) { precondition(near(curvature, 0)) }
            else { precondition(curvature > 0) }
        }
    }
    for edge in [DockEdge.top, .right, .bottom, .left] {
        let placement = PetDockGeometry.screen(edge: edge, near: NSPoint(x: screen.midX, y: screen.midY), in: screen)
        let resting = PetMotion.artwork(contact: placement.contact, frame: placement.frame, pose: petRest)
        let expressive = PetMotion.artwork(contact: placement.contact, frame: placement.frame, pose: draggedPet)
        precondition(zip(points(resting.contour), points(expressive.contour)).allSatisfy { same($0, $1) })
        let restingHit = PetInputHitRegion.bounds(presented: resting, neutral: resting, frame: placement.frame)
        let stablePointer = NSPoint(x: restingHit.maxX - 0.01, y: restingHit.midY)
        for sample in 0...100 {
            let hoverPose = PetMotion.pose(edge: placement.contact.hoverEdge, hover: CGFloat(sample) / 100,
                press: 0, drag: .zero, releaseProgress: 1, blinkProgress: 1, reducedMotion: false)
            let presented = PetMotion.artwork(contact: placement.contact, frame: placement.frame, pose: hoverPose)
            let hit = PetInputHitRegion.bounds(presented: presented, neutral: resting, frame: placement.frame)
            precondition(PetInputHitRegion.accepts(stablePointer, bounds: hit, visible: true, enabled: true, pressing: false, dragging: false))
            precondition(hit.width <= 48 && hit.height <= 48)
            let transparentCorner = NSPoint(x: placement.frame.minX + 1, y: placement.frame.minY + 1)
            precondition(!PetInputHitRegion.accepts(transparentCorner, bounds: hit, visible: true, enabled: true, pressing: false, dragging: false))
            precondition(PetInputHitRegion.accepts(transparentCorner, bounds: hit, visible: true, enabled: true, pressing: true, dragging: false))
            precondition(PetInputHitRegion.accepts(transparentCorner, bounds: hit, visible: true, enabled: true, pressing: false, dragging: true))
            precondition(!PetInputHitRegion.accepts(stablePointer, bounds: hit, visible: false, enabled: true, pressing: true, dragging: true))
        }
    }
    print("FOLIO light anchor: closed 18x2 marker, eight C1 joins, 520 mirror/convex samples, static surface and bounded hover-union hit regions passed")
    let targetWindow = NSRect(x: 300, y: 250, width: 600, height: 350)
    for (edge, point, expectedFraction) in [(DockEdge.top, NSPoint(x: 480, y: 600), CGFloat(0.3)),
                                           (.right, NSPoint(x: 900, y: 355), 0.3),
                                           (.bottom, NSPoint(x: 480, y: 250), 0.3),
                                           (.left, NSPoint(x: 300, y: 355), 0.3)] {
        let anchor = PetDockGeometry.anchor(for: targetWindow, near: point, in: screen)
        precondition(anchor.edge == edge && near(anchor.fraction, expectedFraction))
        let moved = NSRect(x: 320, y: 270, width: 800, height: 400)
        let placement = PetDockGeometry.window(moved, anchor: anchor, in: screen)
        precondition(placement.contact.isWindow)
        switch edge {
        case .top: precondition(placement.contact.point.y == moved.maxY && near(placement.contact.point.x, moved.minX + moved.width * 0.3))
        case .right: precondition(placement.contact.point.x == moved.maxX && near(placement.contact.point.y, moved.minY + moved.height * 0.3))
        case .bottom: precondition(placement.contact.point.y == moved.minY && near(placement.contact.point.x, moved.minX + moved.width * 0.3))
        case .left: precondition(placement.contact.point.x == moved.minX && near(placement.contact.point.y, moved.minY + moved.height * 0.3))
        }
        let maximized = PetDockGeometry.window(screen, anchor: anchor, in: screen)
        let inward = PetDockGeometry.inward(edge)
        precondition(maximized.contact.normal.dx == inward.dx && maximized.contact.normal.dy == inward.dy)
    }
    let dockEnd = PetDockGeometry.screen(edge: .top, near: NSPoint(x: screen.midX, y: screen.maxY), in: screen).frame
    let dockMotion = PetDockTransition(fromFrame: restingChat, toFrame: dockEnd, startedAt: 40, duration: 0.28)
    precondition(dockMotion.value(at: 40).frame.origin == restingChat.origin && dockMotion.value(at: 40).contact == 0)
    precondition(dockMotion.value(at: 40.06).contact > 0
        && dockMotion.value(at: 40.16).contact > dockMotion.value(at: 40.06).contact)
    precondition(dockMotion.value(at: 40.28).frame == dockEnd && dockMotion.value(at: 40.28).contact == 1 && dockMotion.value(at: 40.28).complete)
    let settledLeft = PetDockGeometry.screen(edge: .left, near: NSPoint(x: screen.minX, y: screen.midY), in: screen)
    let nextTop = PetDockGeometry.screen(edge: .top, near: NSPoint(x: screen.midX, y: screen.maxY), in: screen)
    let finalRight = PetDockGeometry.screen(edge: .right, near: NSPoint(x: screen.maxX, y: screen.midY), in: screen)
    let visibleSource = PetMotion.artwork(contact: settledLeft.contact, frame: settledLeft.frame, pose: pressedPet)
    let firstTarget = PetMotion.artwork(contact: nextTop.contact, frame: nextTop.frame, pose: petRest)
    func sameArtwork(_ a: PetArtwork, frame aFrame: NSRect, _ b: PetArtwork, frame bFrame: NSRect) -> Bool {
        guard a.fillets.count == b.fillets.count,
              zip(a.fillets, b.fillets).allSatisfy({ $0.curves.count == $1.curves.count }) else { return false }
        guard a.filletShades.count == b.filletShades.count else { return false }
        for (left, right) in zip(a.filletShades, b.filletShades) {
            guard left.colors.count == right.colors.count,
                  same(NSPoint(x: left.start.x + aFrame.minX, y: left.start.y + aFrame.minY),
                       NSPoint(x: right.start.x + bFrame.minX, y: right.start.y + bFrame.minY)),
                  same(NSPoint(x: left.end.x + aFrame.minX, y: left.end.y + aFrame.minY),
                       NSPoint(x: right.end.x + bFrame.minX, y: right.end.y + bFrame.minY)) else { return false }
            for (a, b) in zip(left.colors, right.colors) {
                guard zip(a.components, b.components).allSatisfy({ near($0, $1) }) else { return false }
            }
        }
        let first = (points(a.contour) + points(a.mascot) + a.fillets.flatMap { points($0) }).map { NSPoint(x: $0.x + aFrame.minX, y: $0.y + aFrame.minY) }
        let second = (points(b.contour) + points(b.mascot) + b.fillets.flatMap { points($0) }).map { NSPoint(x: $0.x + bFrame.minX, y: $0.y + bFrame.minY) }
        return zip(first, second).allSatisfy { same($0, $1) }
            && near(a.baseOpacity, b.baseOpacity) && near(a.adhesionAmount, b.adhesionAmount)
            && same(NSPoint(x: a.face.x + aFrame.minX, y: a.face.y + aFrame.minY),
                    NSPoint(x: b.face.x + bFrame.minX, y: b.face.y + bFrame.minY))
    }
    let changeEdge = PetDockTransition(fromFrame: settledLeft.frame, toFrame: nextTop.frame, startedAt: 60, duration: 0.28)
    let firstFrame = changeEdge.value(at: 60)
    let firstArtwork = PetMotion.interpolate(visibleSource, firstTarget, amount: firstFrame.contact)
    precondition(sameArtwork(visibleSource, frame: settledLeft.frame, firstArtwork, frame: firstFrame.frame))
    let halfway = changeEdge.value(at: 60.15)
    let halfwayArtwork = PetMotion.interpolate(visibleSource, firstTarget, amount: halfway.contact)
    precondition(halfway.contact > 0 && halfway.contact < 1)
    let redirected = PetDockTransition(fromFrame: halfway.frame, toFrame: finalRight.frame, startedAt: 60.15, duration: 0.28)
    let redirectedTarget = PetMotion.artwork(contact: finalRight.contact, frame: finalRight.frame, pose: petRest)
    let redirectedStart = redirected.value(at: 60.15)
    let redirectedArtwork = PetMotion.interpolate(halfwayArtwork, redirectedTarget, amount: redirectedStart.contact)
    precondition(sameArtwork(halfwayArtwork, frame: halfway.frame, redirectedArtwork, frame: redirectedStart.frame))
    let redirectedEnd = redirected.value(at: 60.43)
    precondition(sameArtwork(redirectedTarget, frame: finalRight.frame,
                             PetMotion.interpolate(halfwayArtwork, redirectedTarget, amount: redirectedEnd.contact), frame: redirectedEnd.frame))
    func inPetCanvas(_ artwork: PetArtwork) -> Bool {
        let paths = points(artwork.contour) + points(artwork.mascot)
        let bonds = artwork.fillets.flatMap { points($0) }
        let inBounds = (paths + bonds).allSatisfy { point in
            point.x >= -0.001 && point.x <= size.width + 0.001
                && point.y >= -0.001 && point.y <= size.height + 0.001
        }
        return inBounds && artwork.face.x >= 12 && artwork.face.x <= size.width - 12
            && artwork.face.y >= 12 && artwork.face.y <= size.height - 12
    }
    let freeMascot = PetMotion.artwork(contact: nil, frame: .zero, pose: petRest)
    precondition(freeMascot.baseOpacity == 0)
    for edge in [DockEdge.top, .right, .bottom, .left] {
        let placement = PetDockGeometry.screen(edge: edge, near: NSPoint(x: screen.midX, y: screen.midY), in: screen)
        let docked = PetMotion.artwork(contact: placement.contact, frame: placement.frame, pose: petRest)
        precondition(docked.baseOpacity == 1)
        precondition(zip(points(freeMascot.mascot), points(docked.mascot)).allSatisfy { same($0, $1) })
        let normal = placement.contact.normal, tangent = CGVector(dx: normal.dy, dy: -normal.dx)
        let origin = NSPoint(x: placement.contact.point.x - placement.frame.minX, y: placement.contact.point.y - placement.frame.minY)
        let basePoints = points(docked.contour)
        let across = basePoints.map { ($0.x - origin.x) * tangent.dx + ($0.y - origin.y) * tangent.dy }
        let depth = basePoints.map { ($0.x - origin.x) * normal.dx + ($0.y - origin.y) * normal.dy }
        precondition(near(across.max()! - across.min()!, 18) && near(depth.max()! - depth.min()!, 2))
    }
    for sourceEdge in [DockEdge.top, .right, .bottom, .left] {
        let sourcePlacement = PetDockGeometry.screen(edge: sourceEdge, near: NSPoint(x: screen.midX, y: screen.midY), in: screen)
        let sourcePose = PetMotion.pose(edge: sourceEdge, hover: 1, press: 1, drag: .zero,
                                       releaseProgress: 1, blinkProgress: 1, reducedMotion: false)
        let sourceArtwork = PetMotion.artwork(contact: sourcePlacement.contact, frame: sourcePlacement.frame, pose: sourcePose)
        precondition(inPetCanvas(sourceArtwork))
        for targetEdge in [DockEdge.top, .right, .bottom, .left] {
            let targetPlacement = PetDockGeometry.screen(edge: targetEdge, near: NSPoint(x: screen.midX, y: screen.midY), in: screen)
            let targetPose = PetMotion.pose(edge: targetEdge, hover: 1, press: 0, drag: .zero,
                                           releaseProgress: 0.2, blinkProgress: 0.5, reducedMotion: false)
            let targetArtwork = PetMotion.artwork(contact: targetPlacement.contact, frame: targetPlacement.frame, pose: targetPose)
            let transition = PetDockTransition(fromFrame: sourcePlacement.frame, toFrame: targetPlacement.frame, startedAt: 70, duration: 0.28)
            for step in 0...120 {
                let state = transition.value(at: 70 + 0.28 * Double(step) / 120)
                let displayed = PetMotion.interpolate(sourceArtwork, targetArtwork, amount: state.contact)
                precondition(state.frame.size == size && inPetCanvas(displayed))
                let neutralTarget = PetMotion.artwork(contact: targetPlacement.contact, frame: targetPlacement.frame, pose: petRest)
                let neutralPresented = PetMotion.interpolate(sourceArtwork, neutralTarget, amount: state.contact)
                let hit = PetInputHitRegion.bounds(presented: displayed, neutral: neutralPresented, frame: state.frame)
                let body = PetInputHitRegion.bodyBounds(displayed, in: state.frame)
                precondition(hit.width <= 48 && hit.height <= 48 && hit.contains(body))
                precondition(abs(hit.midX - body.midX) < 3 && abs(hit.midY - body.midY) < 3)
                let retargeted = PetMotion.interpolate(displayed, visibleSource, amount: CGFloat(step) / 120)
                precondition(inPetCanvas(retargeted))
            }
        }
    }
    // Two small separated corner bonds replace every window plate. The screen marker stays unchanged.
    let roomyWindow = NSRect(x: 350, y: 250, width: 500, height: 350)
    var adhesionPlacements: [PetDockPlacement] = []
    for window in [roomyWindow, screen] {
        for edge in [DockEdge.top, .right, .bottom, .left] {
            let placement = PetDockGeometry.window(window, anchor: PetWindowAnchor(edge: edge, fraction: 0.5), in: screen)
            adhesionPlacements.append(placement)
            let normal = placement.contact.normal, tangent = CGVector(dx: normal.dy, dy: -normal.dx)
            precondition(placement.contact.isWindow && normal == PetDockGeometry.inward(edge))
            let rest = PetMotion.artwork(contact: placement.contact, frame: placement.frame, pose: petRest)
            let held = PetMotion.artwork(contact: placement.contact, frame: placement.frame, pose: pressedPet)
            precondition(rest.baseOpacity == 0 && rest.adhesionAmount == 1 && rest.fillets.count == 2)
            precondition(sameArtwork(rest, frame: placement.frame, held, frame: placement.frame))
            precondition(inPetCanvas(rest) && rest.filletShades.count == 2)
            for shade in rest.filletShades {
                precondition(shade.colors.count == 25)
                precondition(shade.colors.allSatisfy { $0.components.allSatisfy { $0.isFinite && $0 >= 0 && $0 <= 1 } })
                precondition(near(hypot(shade.end.x - shade.start.x, shade.end.y - shade.start.y), 10.6))
            }
            let origin = NSPoint(x: placement.contact.point.x - placement.frame.minX, y: placement.contact.point.y - placement.frame.minY)
            let body = CompanionResource.layout.bodyBounds.rect
            let halfAcross = (abs(normal.dy) * body.width + abs(normal.dx) * body.height) * PetMotion.labelScale / 2
            let canonical = PetMotion.adhesionContours(normal: normal)
            precondition(canonical.count == 2 && canonical.allSatisfy { $0.curves.count == 4 })
            precondition(zip(points(canonical[0]), points(canonical[1])).allSatisfy { near($0.x, -$1.x) && near($0.y, $1.y) })
            for (index, patch) in rest.fillets.enumerated() {
                let samples = points(patch)
                let across = samples.map { ($0.x - origin.x) * tangent.dx + ($0.y - origin.y) * tangent.dy }
                let depth = samples.map { ($0.x - origin.x) * normal.dx + ($0.y - origin.y) * normal.dy }
                precondition(near(depth.min()!, 0) && near(depth.max()!, 10.6))
                precondition(across.allSatisfy { index == 0 ? $0 >= halfAcross - 8.000001 : $0 <= -halfAcross + 8.000001 })
                precondition(near(across.max()! - across.min()!, 16.6))
                let outer = canonical[index].curves[0]
                for step in 0...100 {
                    let sample = cubicPoint(start: canonical[index].start, curve: outer, at: CGFloat(step) / 100)
                    precondition(sample.y >= 0 && sample.y <= 10.600001 && abs(sample.x) > halfAcross - 0.251)
                }
            }
            let corners = [NSPoint(x: body.minX, y: body.minY), NSPoint(x: body.maxX, y: body.minY),
                           NSPoint(x: body.maxX, y: body.maxY), NSPoint(x: body.minX, y: body.maxY)].map { rest.labelPoint($0.x, $0.y) }
            let depth = corners.map { ($0.x - origin.x) * normal.dx + ($0.y - origin.y) * normal.dy }
            precondition(near(depth.min()!, -0.12)) // Subpixel overlap, never an air gap.
            let hit = PetInputHitRegion.bounds(presented: held, neutral: rest, frame: placement.frame)
            precondition(hit.width <= 48 && hit.height <= 48 && placement.frame.contains(hit))
            precondition(rest.fillets.flatMap { points($0) }.allSatisfy { hit.contains(NSPoint(x: $0.x + placement.frame.minX, y: $0.y + placement.frame.minY)) })
        }
    }
    let markers = [DockEdge.top, .right, .bottom, .left].map {
        PetDockGeometry.screen(edge: $0, near: NSPoint(x: screen.midX, y: screen.midY), in: screen)
    }
    for source in adhesionPlacements {
        for target in adhesionPlacements + markers {
            let from = PetMotion.artwork(contact: source.contact, frame: source.frame, pose: petRest)
            let to = PetMotion.artwork(contact: target.contact, frame: target.frame, pose: petRest)
            let transition = PetDockTransition(fromFrame: source.frame, toFrame: target.frame, startedAt: 620, duration: 0.28)
            for step in 0...60 {
                let state = transition.value(at: 620 + 0.28 * Double(step) / 60)
                let displayed = PetMotion.interpolate(from, to, amount: state.contact)
                precondition(inPetCanvas(displayed) && displayed.fillets.count == 2)
                precondition(near(displayed.adhesionAmount, from.adhesionAmount + (to.adhesionAmount - from.adhesionAmount) * state.contact))
                let hit = PetInputHitRegion.bounds(presented: displayed, neutral: displayed, frame: state.frame)
                precondition(hit.width <= 48 && hit.height <= 48 && state.frame.contains(hit))
                let reverse = PetMotion.interpolate(to, from, amount: 1 - state.contact)
                precondition(sameArtwork(displayed, frame: state.frame, reverse, frame: state.frame))
            }
            let halfway = transition.value(at: 620.15)
            let snapshot = PetMotion.interpolate(from, to, amount: halfway.contact)
            let redirect = PetDockTransition(fromFrame: halfway.frame, toFrame: source.frame,
                startedAt: 620.15, duration: 0.28, initialVelocity: transition.velocity(at: 620.15))
            let start = redirect.value(at: 620.15)
            precondition(sameArtwork(snapshot, frame: halfway.frame,
                PetMotion.interpolate(snapshot, from, amount: start.contact), frame: start.frame))
            precondition(near(redirect.velocity(at: 620.15).dx, transition.velocity(at: 620.15).dx)
                && near(redirect.velocity(at: 620.15).dy, transition.velocity(at: 620.15).dy))
        }
    }
    for edge in [DockEdge.top, .right, .bottom, .left] {
        let normal = PetDockGeometry.inward(edge)
        for pose in [petRest, pressedPet, draggedPet] {
            let base = PetMotion.artwork(contact: nil, frame: .zero, pose: pose)
            let body = PetInputHitRegion.bodyBounds(base, in: NSRect(origin: .zero, size: size))
            let half = (abs(normal.dx) * body.width + abs(normal.dy) * body.height) / 2
            var previousAmount: CGFloat = 2
            for gap: CGFloat in [0, 3, 7.5, 12, 14.9, 15, 30] {
                let contact = PetContact(point: NSPoint(x: base.face.x - normal.dx * (half - 0.12 + gap),
                    y: base.face.y - normal.dy * (half - 0.12 + gap)), normal: normal, edge: edge, isWindow: true)
                let preview = PetDragAdhesion.preview(base: base, frame: NSRect(origin: .zero, size: size), contact: contact)
                precondition(inPetCanvas(preview) && preview.adhesionAmount <= previousAmount + 0.000001)
                previousAmount = preview.adhesionAmount
                precondition(preview.labelOrigin == base.labelOrigin && preview.labelX == base.labelX && preview.labelY == base.labelY)
                precondition(PetInputHitRegion.bodyBounds(preview, in: .zero) == PetInputHitRegion.bodyBounds(base, in: .zero))
                let hit = PetInputHitRegion.bounds(presented: preview, neutral: base, frame: NSRect(origin: .zero, size: size))
                precondition(hit.width <= 50 && hit.height <= 50)
                let redirected = PetMotion.interpolate(preview, freeMascot, amount: 0)
                precondition(sameArtwork(preview, frame: .zero, redirected, frame: .zero))
                for step in 0...20 {
                    let fade = PetMotion.interpolate(preview, base, amount: CGFloat(step) / 20)
                    precondition(inPetCanvas(fade) && fade.adhesionAmount <= preview.adhesionAmount + 0.000001)
                }
            }
        }
    }
    print("FOLIO early adhesion: real contact distance, monotone 15pt approach, unchanged body/identity, bounded 50pt current hits and continuous release snapshots passed")
    precondition(freeMascot.baseOpacity == 0 && freeMascot.adhesionAmount == 0)
    for index in CompanionResource.layout.eyes.indices {
        let outline = PetHeldExpression.eyeOutline(index: index)
        precondition(CompanionResource.layout.eyeSafeBounds.rect.contains(outline.boundingBoxOfPath))
        precondition(near(outline.boundingBoxOfPath.midX, CompanionResource.layout.eyes[index].cx))
        precondition(near(outline.boundingBoxOfPath.midY, CompanionResource.layout.eyes[index].cy))
    }
    for index in CompanionResource.layout.eyes.indices {
        for step in 0...100 {
            let progress = CGFloat(step) / 100
            let outline = PetHeldExpression.eyeOutline(index: index, amount: progress)
            precondition(CompanionResource.layout.eyeSafeBounds.rect.contains(outline.boundingBoxOfPath))
            for dx: CGFloat in [-1, 1] {
                for dy: CGFloat in [-1, 1] {
                    let corner = PetHeldExpression.eyeOutline(index: index, amount: progress,
                        offset: dx * PetGaze.maximumOffset * (1 - progress),
                        verticalOffset: dy * PetGaze.maximumVerticalOffset * (1 - progress))
                    precondition(CompanionResource.layout.eyeSafeBounds.rect.contains(corner.boundingBoxOfPath))
                }
            }
            precondition(near(outline.boundingBoxOfPath.midX, CompanionResource.layout.eyes[index].cx)
                && near(outline.boundingBoxOfPath.midY, CompanionResource.layout.eyes[index].cy))
        }
        for blink: CGFloat in [0.1, 0.5, 1] {
            let normal = PetHeldExpression.eyeOutline(index: index, amount: 0, openness: blink).boundingBoxOfPath
            let capsule = PetGaze.eyePath(index: index, offset: 0, openness: blink).bounds
            precondition(near(normal.minX, capsule.minX) && near(normal.minY, capsule.minY)
                && near(normal.width, capsule.width) && near(normal.height, capsule.height))
        }
        let heldBlink = PetHeldExpression.eyeOutline(index: index, amount: 0.5, openness: 0.1).boundingBoxOfPath
        precondition(heldBlink == PetHeldExpression.eyeOutline(index: index, amount: 0.5, openness: 1).boundingBoxOfPath)
    }
    precondition(PetHeldExpression.amount(pressing: true, dragging: false, pressAmount: 0, reducedMotion: true) == 1)
    precondition(PetHeldExpression.amount(pressing: false, dragging: true, pressAmount: 0, reducedMotion: false) == 0)
    precondition(PetHeldExpression.amount(pressing: false, dragging: false, pressAmount: 0, reducedMotion: true) == 0)
    precondition(PetHeldExpression.amount(pressing: true, dragging: false, pressAmount: 0.5, reducedMotion: false) == 0.5)
    let pressRise = PetScalarTransition(from: 0, to: 1, startedAt: 700, duration: 0.09)
    let beforeDrag = pressRise.value(at: 700.045).amount
    precondition(near(PetHeldExpression.amount(pressing: true, dragging: false, pressAmount: beforeDrag, reducedMotion: false),
                      PetHeldExpression.amount(pressing: true, dragging: true, pressAmount: beforeDrag, reducedMotion: false)))
    let quickRelease = PetScalarTransition(from: beforeDrag, to: 0, startedAt: 700.045, duration: 0.16)
    precondition(near(quickRelease.value(at: 700.045).amount, beforeDrag))
    precondition(quickRelease.value(at: 700.125).amount > 0 && quickRelease.value(at: 700.205).amount == 0)
    // A resumed normal-motion held state retains the same semantic expression as reduced motion.
    precondition(PetHeldExpression.amount(pressing: true, dragging: false, pressAmount: 1, reducedMotion: false)
        == PetHeldExpression.amount(pressing: true, dragging: false, pressAmount: 0, reducedMotion: true))
    print("FOLIO direct attachment: inward four edges, half-body stand-off, extended shell-sampled corner fillets, no window plate, bare hit bounds and continuous 96 routes passed")
    print("FOLIO held expression: single silhouette capsule/chevron morph, normal equivalence, full-range safety, continuous threshold/release and blink suppression passed")
    // Visibility uses only bounds/z-order; a foreground overlap in transparent canvas corners is harmless.
    let ownerPID: pid_t = 901, selfPID: pid_t = 902
    let ownerFrame = NSRect(x: 350, y: 250, width: 500, height: 350)
    let tracked = AttachedWindow(id: 701, pid: ownerPID, appName: "Tracked", bundleID: nil, title: "",
        cgBounds: CGRect(x: ownerFrame.minX, y: 900 - ownerFrame.maxY, width: ownerFrame.width, height: ownerFrame.height))
    func metadata(_ id: CGWindowID, pid: pid_t, frame: NSRect, onScreen: Bool = true, layer: Int = 0) -> PetWindowMetadata {
        PetWindowMetadata(id: id, pid: pid, bounds: CGRect(x: frame.minX, y: 900 - frame.maxY,
            width: frame.width, height: frame.height), layer: layer, onScreen: onScreen, alpha: 1)
    }
    let ownerRow = metadata(701, pid: ownerPID, frame: ownerFrame)
    for edge in [DockEdge.top, .right, .bottom, .left] {
        let placement = PetDockGeometry.window(ownerFrame, anchor: PetWindowAnchor(edge: edge, fraction: 0.63), in: screen)
        let art = PetMotion.artwork(contact: placement.contact, frame: placement.frame, pose: petRest)
        let body = PetInputHitRegion.bodyBounds(art, in: placement.frame)
        func covered(_ rows: [PetWindowMetadata]) -> Bool {
            PetAttachmentVisibility.isCovered(body: body, contact: placement.contact, target: tracked,
                windows: rows, primaryTop: 900, ownPID: selfPID, fillets: art.fillets, artworkFrame: placement.frame)
        }
        let foreground = metadata(702, pid: 903, frame: body)
        let ownChat = metadata(703, pid: selfPID, frame: body)
        let transparentCorner = metadata(704, pid: 903, frame: NSRect(x: placement.frame.minX + 1, y: placement.frame.minY + 1, width: 7, height: 7))
        precondition(covered([foreground, ownerRow]))
        precondition(covered([metadata(706, pid: 903, frame: body, layer: 3), ownerRow]))
        precondition(!covered([metadata(707, pid: 903, frame: body, layer: 24), ownerRow]))
        precondition(!PetAttachmentVisibility.isCovered(body: body, contact: placement.contact, target: tracked,
            windows: [metadata(708, pid: 903, frame: body, layer: 3), ownerRow], primaryTop: 900,
            ownPID: selfPID, fillets: art.fillets, artworkFrame: placement.frame, maximumLayer: 0))
        precondition(!covered([ownerRow, foreground]) && !covered([ownChat, ownerRow]))
        precondition(!covered([ownerRow, metadata(709, pid: 903, frame: body, layer: 3)]))
        precondition(!covered([transparentCorner, ownerRow]))
        let curve = art.fillets[0].curves[0]
        let arcPoint = cubicPoint(start: art.fillets[0].start, curve: curve, at: 0.25)
        let arcOnly = NSRect(x: arcPoint.x + placement.frame.minX - 0.5, y: arcPoint.y + placement.frame.minY - 0.5, width: 1, height: 1)
        precondition(covered([metadata(705, pid: 903, frame: arcOnly), ownerRow]))
        precondition(covered([metadata(710, pid: 903, frame: arcOnly, layer: 3), ownerRow]))
        precondition(!covered([metadata(711, pid: 903, frame: arcOnly, layer: 24), ownerRow]))
        precondition(!PetAttachmentVisibility.canFit(NSRect(x: 0, y: 0, width: 20, height: 20), edge: edge))
        precondition(PetAttachmentVisibility.canFit(ownerFrame, edge: edge, in: screen))
    }
    precondition(PetAttachmentVisibility.canFit(NSRect(x: 350, y: 250, width: 132, height: 100), edge: .top, in: screen))
    precondition(!PetAttachmentVisibility.canFit(NSRect(x: 350, y: 250, width: 131.9, height: 100), edge: .top, in: screen))
    let topAnchorSmall = PetWindowAnchor(edge: .top, fraction: 0.02)
    let top238 = PetDockGeometry.window(NSRect(x: 350, y: 250, width: 238, height: 200), anchor: topAnchorSmall, in: screen)
    let top242 = PetDockGeometry.window(NSRect(x: 350, y: 250, width: 242, height: 200), anchor: topAnchorSmall, in: screen)
    precondition(near(top238.contact.point.x, 446) && near(top242.contact.point.x, 446))
    print("FOLIO attachment visibility: four-edge body/fillet occlusion at layers 0...pet, high-layer/own-overlay/transparent-canvas exclusion, resize fit and stable traffic-light inset passed")
    // The approved PNG and its JSON source pixels are the actual runtime geometry.
    let authored = CompanionResource.layout
    let shell = CompanionResource.image
    let blendMask = PetFilletMaterial.rimBlendMask
    precondition(blendMask.image.width == 288 && blendMask.image.height == 336)
    let faceProtection = authored.windowBounds.rect
    for point in [NSPoint(x: faceProtection.minX, y: faceProtection.minY),
                  NSPoint(x: faceProtection.midX, y: faceProtection.midY),
                  NSPoint(x: faceProtection.maxX - 0.01, y: faceProtection.maxY - 0.01),
                  NSPoint(x: authored.bodyBounds.rect.maxX - 120, y: authored.bodyBounds.rect.maxY - 120)] {
        precondition(PetFilletMaterial.rimBlendWeight(at: point) == 0)
    }
    precondition(PetFilletMaterial.rimBlendWeight(at: NSPoint(x: authored.bodyBounds.rect.maxX + 100,
        y: authored.bodyBounds.rect.midY)) == 1)
    precondition(authored.version >= 6 && shell.width == Int(authored.canvas.width) && shell.height == Int(authored.canvas.height))
    precondition(shell.alphaInfo != .none && shell.alphaInfo != .noneSkipFirst && shell.alphaInfo != .noneSkipLast)
    precondition(authored.viewport.rect.contains(authored.bodyBounds.rect))
    precondition(authored.windowBounds.rect.contains(authored.eyeSafeBounds.rect))
    precondition(near(authored.bodyBounds.width * PetMotion.labelScale, authored.nativeBodyWidth))
    let rasterExtent = points(PetMotion.mascotContour)
    precondition(rasterExtent.count == 25)
    precondition(near(rasterExtent.map { $0.x }.max()! - rasterExtent.map { $0.x }.min()!, authored.viewport.width * PetMotion.labelScale))
    precondition(near(rasterExtent.map { $0.y }.max()! - rasterExtent.map { $0.y }.min()!, authored.viewport.height * PetMotion.labelScale))
    let defaultPair = NSPoint(x: (authored.eyes[0].cx + authored.eyes[1].cx) / 2,
                             y: (authored.eyes[0].cy + authored.eyes[1].cy) / 2)
    precondition(abs(defaultPair.x - authored.faceCenter.x) < 0.001 && abs(defaultPair.y - authored.faceCenter.y) < 0.001)
    let normalizedPair = NSPoint(x: (defaultPair.x - authored.bodyBounds.x) / authored.bodyBounds.width,
                                y: (defaultPair.y - authored.bodyBounds.y) / authored.bodyBounds.height)
    precondition(normalizedPair.x > 0.49 && normalizedPair.x < 0.51 && normalizedPair.y > 0.40 && normalizedPair.y < 0.42)
    precondition(near(authored.eyes[1].cy, authored.eyes[0].cy))
    precondition(authored.eyes.allSatisfy { $0.angle == 0 })
    precondition(near(defaultPair.x, authored.windowBounds.rect.midX) && near(defaultPair.y, authored.windowBounds.rect.midY))
    // At rest, source horizontal/vertical edges stay horizontal/vertical on every surface.
    precondition(petRest.tilt == 0)
    let restHorizontalA = freeMascot.labelPoint(authored.bodyBounds.x, authored.bodyBounds.rect.midY)
    let restHorizontalB = freeMascot.labelPoint(authored.bodyBounds.rect.maxX, authored.bodyBounds.rect.midY)
    let restVerticalA = freeMascot.labelPoint(authored.bodyBounds.rect.midX, authored.bodyBounds.y)
    let restVerticalB = freeMascot.labelPoint(authored.bodyBounds.rect.midX, authored.bodyBounds.rect.maxY)
    precondition(near(restHorizontalA.y, restHorizontalB.y) && near(restVerticalA.x, restVerticalB.x))
    for artwork in [freeMascot, visibleSource, firstTarget, halfwayArtwork, redirectedArtwork] {
        for coordinate in [NSPoint(x: authored.eyes[0].cx, y: authored.eyes[0].cy),
                           NSPoint(x: authored.eyes[1].cx, y: authored.eyes[1].cy),
                           NSPoint(x: authored.viewport.x, y: authored.viewport.y),
                           NSPoint(x: authored.viewport.rect.maxX, y: authored.viewport.rect.maxY)] {
            let feature = artwork.labelPoint(coordinate.x, coordinate.y)
            precondition(feature.x.isFinite && feature.y.isFinite && feature.x >= 0 && feature.x <= size.width
                && feature.y >= 0 && feature.y <= size.height)
        }
    }
    let gazeScreen = NSRect(x: 100, y: 50, width: 1200, height: 800)
    let gazeCenter = NSPoint(x: 700, y: 450)
    precondition(PetGaze.target(pointer: NSPoint(x: 101, y: 450), center: gazeCenter, screen: gazeScreen) == -PetGaze.maximumOffset)
    precondition(PetGaze.target(pointer: NSPoint(x: 1299, y: 450), center: gazeCenter, screen: gazeScreen) == PetGaze.maximumOffset)
    precondition(PetGaze.target(pointer: gazeCenter, center: gazeCenter, screen: gazeScreen) == 0)
    for point in [NSPoint(x: -10000, y: 450), NSPoint(x: CGFloat.infinity, y: 450), NSPoint(x: CGFloat.nan, y: 450)] {
        precondition(PetGaze.target(pointer: point, center: gazeCenter, screen: gazeScreen) == 0)
    }
    precondition(PetGaze.target(pointer: NSPoint(x: 1100, y: 200), center: gazeCenter, screen: gazeScreen)
        == PetGaze.target(pointer: NSPoint(x: 1100, y: 700), center: gazeCenter, screen: gazeScreen))
    precondition(PetGaze.target(pointer: NSPoint(x: 1100, y: 450), center: gazeCenter, screen: gazeScreen, reducedMotion: true) == 0)
    precondition(PetGaze.target(pointer: NSPoint(x: 1100, y: 450), center: gazeCenter, screen: gazeScreen, visible: false) == 0)
    let leftDisplay = NSRect(x: -1400, y: -100, width: 1200, height: 900)
    let leftCenter = NSPoint(x: -800, y: 350)
    precondition(PetGaze.target(pointer: NSPoint(x: -1399, y: 350), center: leftCenter, screen: leftDisplay) == -PetGaze.maximumOffset)
    precondition(PetGaze.target(pointer: NSPoint(x: -201, y: 350), center: leftCenter, screen: leftDisplay) == PetGaze.maximumOffset)
    precondition(PetGaze.target(pointer: NSPoint(x: 100, y: 350), center: leftCenter, screen: leftDisplay) == 0)
    for offset: CGFloat in [-1000, -PetGaze.maximumOffset, -PetGaze.maximumOffset / 2, 0, PetGaze.maximumOffset / 2, PetGaze.maximumOffset, 1000] {
        for openness: CGFloat in [0, 0.1, 0.25, 0.5, 1] {
            let eyes = authored.eyes.indices.map { PetGaze.eyePath(index: $0, offset: offset, openness: openness).bounds }
            for index in eyes.indices {
                precondition(authored.eyeSafeBounds.rect.contains(eyes[index]))
                precondition(near(eyes[index].midX, authored.eyes[index].cx + PetGaze.clampedOffset(offset)))
                precondition(near(eyes[index].midY, authored.eyes[index].cy))
            }
            precondition(near(eyes[1].midX - eyes[0].midX, authored.eyes[1].cx - authored.eyes[0].cx))
            precondition(near(eyes[1].midY, eyes[0].midY))
        }
    }
    // Front-facing capsules stay upright and share a baseline while blinking around their centers.
    for eye in authored.eyes {
        precondition(eye.width == 50 && eye.height == 118 && eye.angle == 0)
        let angle = eye.angle * .pi / 180
        let top = NSPoint(x: eye.cx + sin(angle) * eye.height / 2, y: eye.cy - cos(angle) * eye.height / 2)
        precondition(near(top.x, eye.cx) && top.y < eye.cy)
    }
    for edge in [DockEdge.top, .right, .bottom, .left] {
        let placement = PetDockGeometry.screen(edge: edge, near: gazeCenter, in: gazeScreen)
        let artwork = PetMotion.artwork(contact: placement.contact, frame: placement.frame, pose: petRest)
        for offset: CGFloat in [-PetGaze.maximumOffset, PetGaze.maximumOffset] {
            let displacements = authored.eyes.indices.map { index -> NSPoint in
                let a = artwork.labelPoint(authored.eyes[index].cx, authored.eyes[index].cy)
                let b = artwork.labelPoint(authored.eyes[index].cx + offset, authored.eyes[index].cy)
                return NSPoint(x: b.x - a.x, y: b.y - a.y)
            }
            precondition(same(displacements[0], displacements[1]) && near(displacements[0].y, 0))
            precondition(near(abs(displacements[0].x), PetGaze.maximumOffset * PetMotion.labelScale))
        }
    }
    let lookLeft = PetScalarTransition(from: 0, to: -PetGaze.maximumOffset, startedAt: 200, duration: PetGaze.responseDuration)
    let currentEyeOffset = lookLeft.value(at: 200.065).amount
    let lookRight = PetScalarTransition(from: currentEyeOffset, to: PetGaze.maximumOffset, startedAt: 200.065, duration: PetGaze.responseDuration)
    precondition(lookRight.value(at: 200.065).amount == currentEyeOffset)
    for step in 0...100 {
        let value = lookRight.value(at: 200.065 + PetGaze.responseDuration * Double(step) / 100).amount
        precondition(value >= -PetGaze.maximumOffset - 0.000001 && value <= PetGaze.maximumOffset + 0.000001)
    }
    precondition(PetGaze.returnDelay == 0 && PetGaze.responseDuration == 0.11 && PetGaze.returnDuration == 0.18)
    precondition(near(lookRight.value(at: 200.065 + PetGaze.responseDuration).amount, PetGaze.maximumOffset))
    // Vertical pointer motion uses the opposite sign of source-image y, including negative displays.
    precondition(PetGaze.maximumOffset == 80 && PetGaze.maximumVerticalOffset == 48 && PetGaze.reachBodyScale == 1.5)
    precondition(PetGaze.targetVertical(pointer: NSPoint(x: 700, y: 849), center: gazeCenter, screen: gazeScreen) == -PetGaze.maximumVerticalOffset)
    precondition(PetGaze.targetVertical(pointer: NSPoint(x: 700, y: 51), center: gazeCenter, screen: gazeScreen) == PetGaze.maximumVerticalOffset)
    precondition(PetGaze.targetVertical(pointer: gazeCenter, center: gazeCenter, screen: gazeScreen) == 0)
    precondition(PetGaze.targetVertical(pointer: NSPoint(x: 300, y: 750), center: gazeCenter, screen: gazeScreen)
        == PetGaze.targetVertical(pointer: NSPoint(x: 1100, y: 750), center: gazeCenter, screen: gazeScreen))
    precondition(PetGaze.targetVertical(pointer: NSPoint(x: 700, y: 849), center: gazeCenter, screen: gazeScreen, reducedMotion: true) == 0)
    precondition(PetGaze.targetVertical(pointer: NSPoint(x: 700, y: 849), center: gazeCenter, screen: gazeScreen, visible: false) == 0)
    precondition(PetGaze.targetVertical(pointer: NSPoint(x: -800, y: 799), center: leftCenter, screen: leftDisplay) == -PetGaze.maximumVerticalOffset)
    precondition(PetGaze.targetVertical(pointer: NSPoint(x: -800, y: -99), center: leftCenter, screen: leftDisplay) == PetGaze.maximumVerticalOffset)
    precondition(PetGaze.targetVertical(pointer: NSPoint(x: -800, y: 900), center: leftCenter, screen: leftDisplay) == 0)
    precondition(PetGaze.targetVertical(pointer: NSPoint(x: 700, y: CGFloat.nan), center: gazeCenter, screen: gazeScreen) == 0)
    for dx: CGFloat in [-1000, -PetGaze.maximumOffset, 0, PetGaze.maximumOffset, 1000] {
        for dy: CGFloat in [-1000, -PetGaze.maximumVerticalOffset, 0, PetGaze.maximumVerticalOffset, 1000] {
            for openness: CGFloat in [0, 0.1, 0.5, 1] {
                let eyes = authored.eyes.indices.map {
                    PetGaze.eyePath(index: $0, offset: dx, verticalOffset: dy, openness: openness).bounds
                }
                for index in eyes.indices {
                    precondition(authored.eyeSafeBounds.rect.contains(eyes[index]))
                    precondition(near(eyes[index].midX, authored.eyes[index].cx + PetGaze.clampedOffset(dx)))
                    precondition(near(eyes[index].midY, authored.eyes[index].cy + PetGaze.clampedVerticalOffset(dy)))
                }
                precondition(near(eyes[1].midX - eyes[0].midX, 144) && near(eyes[1].midY, eyes[0].midY))
            }
        }
    }
    for edge in [DockEdge.top, .right, .bottom, .left] {
        let placement = PetDockGeometry.screen(edge: edge, near: gazeCenter, in: gazeScreen)
        let artwork = PetMotion.artwork(contact: placement.contact, frame: placement.frame, pose: petRest)
        for dx: CGFloat in [-PetGaze.maximumOffset, 0, PetGaze.maximumOffset] {
            for dy: CGFloat in [-PetGaze.maximumVerticalOffset, 0, PetGaze.maximumVerticalOffset] {
                let changes = authored.eyes.map { eye -> NSPoint in
                    let initial = artwork.labelPoint(eye.cx, eye.cy)
                    let moved = artwork.labelPoint(eye.cx + dx, eye.cy + dy)
                    return NSPoint(x: moved.x - initial.x, y: moved.y - initial.y)
                }
                precondition(same(changes[0], changes[1]))
                precondition(near(changes[0].x, dx * PetMotion.labelScale) && near(changes[0].y, -dy * PetMotion.labelScale))
            }
        }
    }
    let diagonalX = PetScalarTransition(from: 0, to: PetGaze.maximumOffset, startedAt: 400, duration: PetGaze.responseDuration)
    let diagonalY = PetScalarTransition(from: 0, to: -PetGaze.maximumVerticalOffset, startedAt: 400, duration: PetGaze.responseDuration)
    let diagonalAtTurn = NSPoint(x: diagonalX.value(at: 400.045).amount, y: diagonalY.value(at: 400.045).amount)
    let reverseX = PetScalarTransition(from: diagonalAtTurn.x, to: -PetGaze.maximumOffset, startedAt: 400.045, duration: PetGaze.responseDuration)
    let reverseY = PetScalarTransition(from: diagonalAtTurn.y, to: PetGaze.maximumVerticalOffset, startedAt: 400.045, duration: PetGaze.responseDuration)
    precondition(reverseX.value(at: 400.045).amount == diagonalAtTurn.x && reverseY.value(at: 400.045).amount == diagonalAtTurn.y)
    for sample in 0...100 {
        let time = 400.045 + PetGaze.responseDuration * Double(sample) / 100
        precondition(abs(reverseX.value(at: time).amount) <= PetGaze.maximumOffset + 0.000001 && abs(reverseY.value(at: time).amount) <= PetGaze.maximumVerticalOffset + 0.000001)
    }
    let returnX = PetScalarTransition(from: diagonalAtTurn.x, to: 0, startedAt: 401, duration: PetGaze.returnDuration)
    let returnY = PetScalarTransition(from: diagonalAtTurn.y, to: 0, startedAt: 401, duration: PetGaze.returnDuration)
    precondition(near(returnX.value(at: 401.18).amount, 0) && near(returnY.value(at: 401.18).amount, 0))
    let reaches = PetGaze.localReaches(for: freeMascot)
    precondition(near(reaches.width, authored.nativeBodyWidth * 1.5))
    precondition(near(reaches.height, authored.bodyBounds.height * PetMotion.labelScale * 1.5))
    let halfLeft = NSPoint(x: gazeCenter.x - reaches.width / 2, y: gazeCenter.y)
    let halfRight = NSPoint(x: gazeCenter.x + reaches.width / 2, y: gazeCenter.y)
    let leftTarget = PetGaze.target(pointer: halfLeft, center: gazeCenter, screen: gazeScreen, reach: reaches.width)
    let rightTarget = PetGaze.target(pointer: halfRight, center: gazeCenter, screen: gazeScreen, reach: reaches.width)
    precondition(near(leftTarget, -40) && near(rightTarget, 40))
    let leftEyes = authored.eyes.indices.map { PetGaze.eyePath(index: $0, offset: leftTarget, openness: 1).bounds }
    let rightEyes = authored.eyes.indices.map { PetGaze.eyePath(index: $0, offset: rightTarget, openness: 1).bounds }
    precondition((leftEyes[0].midX + leftEyes[1].midX) / 2 < authored.windowBounds.rect.midX)
    precondition((rightEyes[0].midX + rightEyes[1].midX) / 2 > authored.windowBounds.rect.midX)
    precondition(near(PetGaze.target(pointer: NSPoint(x: gazeCenter.x - reaches.width, y: gazeCenter.y),
        center: gazeCenter, screen: gazeScreen, reach: reaches.width), -80))
    precondition(near(PetGaze.targetVertical(pointer: NSPoint(x: gazeCenter.x, y: gazeCenter.y + reaches.height / 2),
        center: gazeCenter, screen: gazeScreen, reach: reaches.height), -24))
    let largeScreen = NSRect(x: 100, y: 50, width: 2400, height: 1600)
    precondition(near(leftTarget, PetGaze.target(pointer: halfLeft, center: gazeCenter, screen: largeScreen, reach: reaches.width)))
    precondition(near(rightTarget, PetGaze.target(pointer: halfRight, center: gazeCenter, screen: largeScreen, reach: reaches.width)))
    let nearLeftEdge = NSPoint(x: gazeScreen.minX + 5, y: gazeCenter.y)
    precondition(PetGaze.target(pointer: NSPoint(x: gazeScreen.minX, y: gazeCenter.y), center: nearLeftEdge,
        screen: gazeScreen, reach: reaches.width) == -80)
    let pressedArtwork = PetMotion.artwork(contact: nil, frame: .zero, pose: pressedPet)
    let pressedReaches = PetGaze.localReaches(for: pressedArtwork)
    precondition(pressedReaches.width > reaches.width && pressedReaches.height < reaches.height)
    // Real monitor registration/removal on an unordered panel; no screen UI is shown.
    NSApplication.shared.setActivationPolicy(.prohibited)
    let lifecyclePanel = PetPanel(contentRect: NSRect(origin: .zero, size: size),
        styleMask: [.borderless, .nonactivatingPanel], backing: .buffered, defer: false)
    lifecyclePanel.isReleasedWhenClosed = false
    // Transparent canvas requests may exceed a display's visible edge while the body stays inside.
    let negativeCanvasScreen = NSRect(x: -1600, y: -240, width: 1200, height: 900)
    for display in [screen, negativeCanvasScreen] {
        let placement = PetDockGeometry.window(display, anchor: PetWindowAnchor(edge: .top, fraction: 0.5), in: display)
        let requested = placement.frame
        precondition(requested.maxY > display.maxY)
        precondition(lifecyclePanel.constrainFrameRect(requested, to: NSScreen.main) == requested)
        precondition(lifecyclePanel.constrainFrameRect(requested, to: nil) == requested)
        lifecyclePanel.setFrame(requested, display: false)
        // AppKit quantizes NSWindow origins to whole logical points even on a 2x display.
        // Validate that exact conversion rather than treating backing-pixel size as origin precision.
        func matchesWindowOrigin(_ actual: NSPoint, _ wanted: NSPoint) -> Bool {
            (near(actual.x, wanted.x) || near(actual.x, floor(wanted.x)))
                && (near(actual.y, wanted.y) || near(actual.y, floor(wanted.y)))
        }
        if !matchesWindowOrigin(lifecyclePanel.frame.origin, requested.origin) {
            fputs("Unexpected canvas origin: requested \(requested), actual \(lifecyclePanel.frame), scale \(lifecyclePanel.backingScaleFactor)\n", stderr)
        }
        precondition(lifecyclePanel.frame.size == requested.size)
        precondition(matchesWindowOrigin(lifecyclePanel.frame.origin, requested.origin))
        let ideal = PetMotion.artwork(contact: placement.contact, frame: requested, pose: petRest)
        let actual = PetMotion.artwork(contact: placement.contact, frame: lifecyclePanel.frame, pose: petRest)
        precondition(sameArtwork(ideal, frame: requested, actual, frame: lifecyclePanel.frame))
        let origin = requested.origin
        lifecyclePanel.setFrameOrigin(origin)
        precondition(lifecyclePanel.frame.size == requested.size)
        precondition(matchesWindowOrigin(lifecyclePanel.frame.origin, requested.origin))
    }
    lifecyclePanel.setFrame(NSRect(origin: .zero, size: size), display: false)
    print("FOLIO transparent canvas: top and negative-display requests retain exact whole-point AppKit origin conversion and completed artwork world coordinates passed")
    let lifecycleView = PetView(frame: NSRect(origin: .zero, size: size))
    let proxyRegion = PetInputHitRegion.bounds(presented: freeMascot, neutral: freeMascot, frame: lifecyclePanel.frame)
    let inputProxy = PetInputPanel.make(region: proxyRegion, target: lifecycleView)
    precondition(!inputProxy.ignoresMouseEvents && !inputProxy.canBecomeKey && !inputProxy.canBecomeMain)
    precondition(inputProxy.isAccessibilityHidden() && inputProxy.isAccessibilityElement() == false)
    precondition(inputProxy.contentView?.isAccessibilityHidden() == true && inputProxy.contentView?.acceptsFirstMouse(for: nil) == true)
    precondition(inputProxy.contentView is PetInputView && proxyRegion.width <= 48 && proxyRegion.height <= 48)
    precondition(!proxyRegion.contains(NSPoint(x: lifecyclePanel.frame.minX + 1, y: lifecyclePanel.frame.minY + 1)))
    inputProxy.close()
    lifecyclePanel.contentView = lifecycleView
    precondition(lifecyclePanel.ignoresMouseEvents)
    // Temporary gaps in window metadata preserve the original attachment and its identity.
    let followOwner = CuratorApp()
    let retainedWindow = AttachedWindow(id: UInt32.max, pid: getpid(), appName: "Self fixture", bundleID: nil, title: "",
        cgBounds: tracked.cgBounds)
    let minimizedRow = PetWindowMetadata(id: UInt32.max, pid: getpid(), bounds: tracked.cgBounds, layer: 0, onScreen: false, alpha: 1)
    let minimized = followOwner.refreshedRunningWindow(retainedWindow,
        scene: PetWindowScene(recordedAt: 1000, all: [minimizedRow], frontToBack: []))
    precondition(minimized.availability == .suspended && minimized.target.token == retainedWindow.token)
    let otherWindow = PetWindowMetadata(id: retainedWindow.id - 1, pid: retainedWindow.pid,
        bounds: retainedWindow.cgBounds, layer: 0, onScreen: true, alpha: 1)
    let otherProcess = PetWindowMetadata(id: retainedWindow.id, pid: retainedWindow.pid + 1,
        bounds: retainedWindow.cgBounds, layer: 0, onScreen: true, alpha: 1)
    let revealItem = NSMenuItem(title: "打开正在关注的页面", action: #selector(CuratorApp.openFocusedPage), keyEquivalent: "")
    precondition(!followOwner.validateMenuItem(revealItem))
    followOwner.attachment = retainedWindow
    precondition(followOwner.validateMenuItem(revealItem))
    precondition(WindowProbe.matchingMetadata(for: retainedWindow, in: [otherWindow, otherProcess]) == nil)
    precondition(WindowProbe.matchingMetadata(for: retainedWindow, in: [otherWindow, otherProcess, minimizedRow])?.onScreen == false)
    print("FOLIO focus menu: enabled only for an attachment, same-process and same-ID neighbors rejected, minimized target retained")
    func missingWindow(at time: TimeInterval) -> PetWindowFollowResult {
        let neighbors = [otherWindow, otherProcess]
        return followOwner.refreshedRunningWindow(retainedWindow,
            scene: PetWindowScene(recordedAt: time, all: neighbors, frontToBack: neighbors))
    }
    // The window list is cached for 100ms, so a real transient gap can span three successful snapshots.
    for time in [1001.0, 1001.1, 1001.2, 1001.2] {
        let missing = missingWindow(at: time)
        precondition(missing.availability == .suspended && missing.target.token == retainedWindow.token)
    }
    let returnedRow = PetWindowMetadata(id: retainedWindow.id, pid: retainedWindow.pid,
        bounds: retainedWindow.cgBounds.offsetBy(dx: 12, dy: 6), layer: 0, onScreen: true, alpha: 1)
    let returned = followOwner.refreshedRunningWindow(retainedWindow,
        scene: PetWindowScene(recordedAt: 1001.3, all: [], frontToBack: [returnedRow]))
    precondition(returned.availability == .visible && returned.target.token == retainedWindow.token)
    precondition(returned.target.cgBounds == returnedRow.bounds)
    // The front list's matching row cleared the old absence interval.
    precondition(missingWindow(at: 1003.4).availability == .suspended)
    precondition(missingWindow(at: 1005.3).availability == .suspended)
    // An unavailable all-window snapshot cannot establish continued absence.
    precondition(followOwner.refreshedRunningWindow(retainedWindow,
        scene: PetWindowScene(recordedAt: 1005.4, all: nil, frontToBack: nil)).availability == .suspended)
    for time in [1005.5, 1005.5, 1005.6, 1007.4] {
        precondition(missingWindow(at: time).availability == .suspended)
    }
    precondition(missingWindow(at: 1007.6).availability == .closed)
    let helper = AttachedWindow(id: retainedWindow.id, pid: pid_t.max, appName: "Helper fixture", bundleID: nil,
        title: "", cgBounds: tracked.cgBounds)
    let helperRow = PetWindowMetadata(id: helper.id, pid: helper.pid,
        bounds: helper.cgBounds, layer: 0, onScreen: true, alpha: 1)
    let helperResult = followOwner.refreshedWindow(helper,
        scene: PetWindowScene(recordedAt: 1008, all: [helperRow], frontToBack: [helperRow]))
    precondition(helperResult.availability == .visible && helperResult.target.token == helper.token)
    print("FOLIO input proxy: bounded always-receptive independent window, first click accepted, AX hidden and visual canvas click-through passed")
    print("FOLIO window liveness: temporary absence preserves attachment, exact windows can recover, and missing app metadata does not imply closure")
    let initialLifecycle = lifecycleView.gazeLifecycleSnapshot
    if !NSWorkspace.shared.accessibilityDisplayShouldReduceMotion {
        precondition(initialLifecycle.monitorCount == 2 && initialLifecycle.hasVisibilityObserver && initialLifecycle.enabled)
        let contextArtwork = lifecycleView.gazeBodySnapshot
        let contextFrame = NSRect(x: 500, y: 350, width: 72, height: 84)
        let contextFace = contextArtwork.labelPoint(authored.faceCenter.x, authored.faceCenter.y)
        let contextReaches = PetGaze.localReaches(for: contextArtwork)
        let stationaryPointer = NSPoint(x: contextFrame.minX + contextFace.x - contextReaches.width / 2,
                                        y: contextFrame.minY + contextFace.y)
        let contextTime = ProcessInfo.processInfo.systemUptime
        precondition(lifecycleView.trackGazeContext(pointer: stationaryPointer, artwork: contextArtwork,
            frame: contextFrame, screen: gazeScreen, at: contextTime))
        precondition(lifecycleView.gazeLifecycleSnapshot.horizontalTarget < 0)
        precondition(!lifecycleView.trackGazeContext(pointer: stationaryPointer, artwork: contextArtwork,
            frame: contextFrame, screen: gazeScreen, at: contextTime + 0.001))
        let movedContextFrame = contextFrame.offsetBy(dx: -contextReaches.width, dy: 0)
        precondition(lifecycleView.trackGazeContext(pointer: stationaryPointer, artwork: contextArtwork,
            frame: movedContextFrame, screen: gazeScreen, at: contextTime + 0.002))
        let targetBeforeScale = lifecycleView.gazeLifecycleSnapshot.horizontalTarget
        precondition(targetBeforeScale > 0)
        let enlargedPose = PetPose(translation: .zero, scale: NSSize(width: 1.6, height: 1.6), tilt: 0, eyeOpenness: 1)
        let enlargedArtwork = PetMotion.artwork(contact: nil, frame: .zero, pose: enlargedPose)
        let enlargedFace = enlargedArtwork.labelPoint(authored.faceCenter.x, authored.faceCenter.y)
        let enlargedFrame = movedContextFrame.offsetBy(dx: contextFace.x - enlargedFace.x, dy: contextFace.y - enlargedFace.y)
        precondition(lifecycleView.trackGazeContext(pointer: stationaryPointer, artwork: enlargedArtwork,
            frame: enlargedFrame, screen: gazeScreen, at: contextTime + 0.003))
        precondition(lifecycleView.gazeLifecycleSnapshot.horizontalTarget > 0
            && lifecycleView.gazeLifecycleSnapshot.horizontalTarget < targetBeforeScale)
        let bodyBeforeGaze = lifecycleView.gazeBodySnapshot
        let sourceTime = ProcessInfo.processInfo.systemUptime
        lifecycleView.setGazeTarget(PetGaze.maximumOffset, vertical: -PetGaze.maximumVerticalOffset, at: sourceTime)
        precondition(lifecycleView.gazeLifecycleSnapshot.horizontalMoving && lifecycleView.gazeLifecycleSnapshot.verticalMoving)
        precondition(lifecycleView.gazeLifecycleSnapshot.hasFrameTimer)
        lifecycleView.scheduleGazeReturn()
        precondition(!lifecycleView.gazeLifecycleSnapshot.hasReturnTimer)
        lifecycleView.setGazeTarget(-PetGaze.maximumOffset, vertical: PetGaze.maximumVerticalOffset, at: sourceTime + 5)
        precondition(near(lifecycleView.gazeLifecycleSnapshot.offset, PetGaze.maximumOffset)
            && near(lifecycleView.gazeLifecycleSnapshot.verticalOffset, -PetGaze.maximumVerticalOffset))
        precondition(!lifecycleView.gazeLifecycleSnapshot.hasReturnTimer)
        lifecycleView.setGazeTarget(-PetGaze.maximumOffset, vertical: PetGaze.maximumVerticalOffset, at: sourceTime + 5.04)
        precondition(abs(lifecycleView.gazeLifecycleSnapshot.offset) > 0 && abs(lifecycleView.gazeLifecycleSnapshot.verticalOffset) > 0)
        let bodyAfterGaze = lifecycleView.gazeBodySnapshot
        precondition(sameArtwork(bodyBeforeGaze, frame: lifecyclePanel.frame, bodyAfterGaze, frame: lifecyclePanel.frame))
        precondition(PetInputHitRegion.bodyBounds(bodyBeforeGaze, in: lifecyclePanel.frame)
            == PetInputHitRegion.bodyBounds(bodyAfterGaze, in: lifecyclePanel.frame))
        lifecycleView.setGazeTarget(0, vertical: PetGaze.maximumVerticalOffset, at: sourceTime + 5.05)
        precondition(lifecycleView.gazeLifecycleSnapshot.horizontalDuration == PetGaze.responseDuration
            && lifecycleView.gazeLifecycleSnapshot.verticalDuration == PetGaze.responseDuration)
        lifecycleView.setGazeTarget(0, vertical: 0, at: sourceTime + 5.06)
        precondition(lifecycleView.gazeLifecycleSnapshot.horizontalDuration == PetGaze.returnDuration
            && lifecycleView.gazeLifecycleSnapshot.verticalDuration == PetGaze.returnDuration)
        lifecycleView.setGazeTarget(PetGaze.maximumOffset, vertical: 0, at: sourceTime + 5.07)
        precondition(lifecycleView.gazeLifecycleSnapshot.horizontalDuration == PetGaze.responseDuration
            && lifecycleView.gazeLifecycleSnapshot.verticalDuration == PetGaze.responseDuration)
        NotificationCenter.default.post(name: NSWindow.didChangeOcclusionStateNotification, object: lifecyclePanel)
        let hiddenGaze = lifecycleView.gazeLifecycleSnapshot
        precondition(hiddenGaze.offset == 0 && hiddenGaze.verticalOffset == 0 && !hiddenGaze.horizontalMoving && !hiddenGaze.verticalMoving)
        precondition(!hiddenGaze.hasReturnTimer)
        lifecycleView.setGazeTarget(PetGaze.maximumOffset, vertical: PetGaze.maximumVerticalOffset, at: sourceTime + 5.05)
        lifecycleView.setGazeTarget(-PetGaze.maximumOffset, vertical: -PetGaze.maximumVerticalOffset, at: sourceTime + 5.08)
        lifecycleView.hasDelivery = true
        precondition(lifecycleView.gazeLifecycleSnapshot.hasFrameTimer)
    }
    precondition(lifecycleView.inputLifecycleSnapshot.enabled && lifecycleView.inputLifecycleSnapshot.observerCount == 4)
    lifecycleView.setHover(true)
    let hoverStarted = lifecycleView.inputLifecycleSnapshot.hoverStartedAt
    for _ in 0..<100 { lifecycleView.setHover(true) }
    precondition(lifecycleView.inputLifecycleSnapshot.hoverStartedAt == hoverStarted)
    let inputOwner = CuratorApp()
    lifecycleView.owner = inputOwner
    inputOwner.attachment = tracked
    inputOwner.attachmentSuspensionReason = "coveredTarget(qa-fixture)"
    inputOwner.isPetDragActive = true
    inputOwner.dragTimer = Timer(timeInterval: 60, repeats: false) { _ in }
    lifecycleView.dragging = true
    precondition((lifecycleView.accessibilityValue() as? String)?.hasPrefix("表情：拖动中") == true)
    if !CommandLine.arguments.contains("--pet-accessibility-qa") {
        precondition(lifecycleView.accessibilityValue() as? String == "表情：拖动中")
    }
    let hiddenExpressionBeforeCancel = lifecycleView.heldExpressionAmount
    precondition(hiddenExpressionBeforeCancel >= 0 && hiddenExpressionBeforeCancel <= 1)
    lifecycleView.refreshInputHit() // The panel is hidden: cancel capture and its active drag probe.
    precondition(!lifecycleView.inputLifecycleSnapshot.forcingCapture && lifecycleView.inputLifecycleSnapshot.canceledGesture
        && lifecycleView.heldExpressionAmount == 0)
    precondition((lifecycleView.accessibilityValue() as? String)?.hasPrefix("表情：跟随鼠标") == true)
    precondition(!inputOwner.isPetDragActive && inputOwner.dragTimer == nil && lifecyclePanel.ignoresMouseEvents)
    let generationAfterCancel = inputOwner.dragGeneration
    let lateDrag = NSEvent.mouseEvent(with: .leftMouseDragged, location: NSPoint(x: 200, y: 200), modifierFlags: [], timestamp: 299,
        windowNumber: lifecyclePanel.windowNumber, context: nil, eventNumber: 1, clickCount: 1, pressure: 1)!
    lifecycleView.mouseDragged(with: lateDrag)
    precondition(inputOwner.dragGeneration == generationAfterCancel && !inputOwner.isPetDragActive
        && inputOwner.dragTimer == nil && !lifecycleView.dragging)
    let lateUp = NSEvent.mouseEvent(with: .leftMouseUp, location: .zero, modifierFlags: [], timestamp: 300,
        windowNumber: lifecyclePanel.windowNumber, context: nil, eventNumber: 1, clickCount: 1, pressure: 0)!
    lifecycleView.mouseUp(with: lateUp)
    precondition(inputOwner.chat == nil && !lifecycleView.inputLifecycleSnapshot.canceledGesture && lifecycleView.heldExpressionAmount == 0)
    lifecycleView.installInputEventMonitors()
    precondition(lifecycleView.inputLifecycleSnapshot.monitorCount == 2)
    lifecycleView.stopAnimationTimers(includingInput: false)
    lifecycleView.refreshGazeForCurrentBody()
    precondition(!lifecycleView.gazeLifecycleSnapshot.hasTrackingSample && !lifecycleView.gazeLifecycleSnapshot.hasReturnTimer)
    precondition(lifecycleView.inputLifecycleSnapshot.enabled && lifecycleView.inputLifecycleSnapshot.monitorCount == 2)
    precondition(lifecycleView.gazeLifecycleSnapshot.monitorCount == 0 && !lifecycleView.gazeLifecycleSnapshot.hasFrameTimer)
    lifecycleView.stopAnimationTimers()
    precondition(!lifecycleView.inputLifecycleSnapshot.enabled && lifecycleView.inputLifecycleSnapshot.monitorCount == 0
        && lifecycleView.inputLifecycleSnapshot.observerCount == 0)
    lifecycleView.installInputEventMonitors(); lifecycleView.refreshInputHit()
    precondition(lifecycleView.inputLifecycleSnapshot.monitorCount == 0 && lifecyclePanel.ignoresMouseEvents)
    lifecycleView.hasDelivery = true // A late backend completion must not recreate a stopped timer.
    lifecycleView.scheduleGazeReturn()
    let cleaned = lifecycleView.gazeLifecycleSnapshot
    precondition(cleaned.monitorCount == 0 && !cleaned.hasReturnTimer && !cleaned.hasFrameTimer
        && !cleaned.hasBlinkTimer && !cleaned.hasVisibilityObserver && !cleaned.enabled
        && cleaned.offset == 0 && cleaned.verticalOffset == 0 && !cleaned.horizontalMoving && !cleaned.verticalMoving)
    lifecyclePanel.contentView = nil; lifecyclePanel.close()
    lifecycleView.updateMotionPreferences() // Detached views also stay stopped.
    precondition(lifecycleView.gazeLifecycleSnapshot.monitorCount == 0)
    print("FOLIO approved shell: cached transparent PNG/JSON dimensions, native body scale and source-pixel viewport passed")
    print("FOLIO frontal eyes: original default eye/body placement, 110/180ms two-axis pairing, corner/blink containment and four-surface coordinate signs passed")
    print("FOLIO local gaze: centered window eyes, near-card 1.5x reach, inner-ring directional centroids, screen-size independence and full corner safety passed")
    print("FOLIO 2D gaze: up/down signs, negative displays, diagonal continuity, stationary-pointer body/reach refresh, idle=0 hold and body/input independence passed")
    print("FOLIO gaze lifecycle: passive monitors registered/removed, idle=0 disables return timers, late callbacks cannot restart stopped frames passed")
    print("FOLIO input lifecycle: independent monitors survive visual stop, hidden drag cancels, late mouseUp suppressed, hover refresh idempotent and full cleanup passed")
    let clickActions = PetPointerClicks()
    var clickDestinations: [String] = []
    func finishTestClick(_ count: Int) {
        clickActions.finish(count: count, interval: 0.02,
            single: { clickDestinations.append("chat") }, double: { clickDestinations.append("stage") })
    }
    func waitForTestClick() {
        RunLoop.main.run(until: Date().addingTimeInterval(0.06))
    }
    clickActions.begin(count: 1); finishTestClick(1)
    precondition(clickDestinations.isEmpty)
    waitForTestClick()
    precondition(clickDestinations == ["chat"])
    clickDestinations.removeAll()
    clickActions.begin(count: 1); finishTestClick(1)
    clickActions.begin(count: 2)
    waitForTestClick()
    precondition(clickDestinations.isEmpty)
    finishTestClick(2)
    waitForTestClick()
    precondition(clickDestinations == ["stage"])
    clickActions.begin(count: 1); finishTestClick(1)
    clickActions.cancel()
    waitForTestClick()
    precondition(clickDestinations == ["stage"])
    print("FOLIO Tag clicks: single toggles chat, double opens only the stage and canceled actions do not fire")
    // Position AND velocity continue through a new destination, including reversal.
    let moving = PetDockTransition(fromFrame: settledLeft.frame, toFrame: nextTop.frame, startedAt: 80, duration: 0.28)
    let interruption = moving.value(at: 80.13), velocity = moving.velocity(at: 80.13)
    let continued = PetDockTransition(fromFrame: interruption.frame, toFrame: finalRight.frame,
        startedAt: 80.13, duration: 0.28, initialVelocity: velocity)
    precondition(continued.value(at: 80.13).frame == interruption.frame)
    precondition(near(continued.velocity(at: 80.13).dx, velocity.dx) && near(continued.velocity(at: 80.13).dy, velocity.dy))
    let epsilon: CGFloat = 0.000001
    let justAfter = continued.value(at: 80.13 + Double(epsilon)).frame
    precondition(abs((justAfter.minX - interruption.frame.minX) / epsilon - velocity.dx) < 0.1)
    precondition(abs((justAfter.minY - interruption.frame.minY) / epsilon - velocity.dy) < 0.1)
    precondition(continued.value(at: 80.41).frame == finalRight.frame && continued.velocity(at: 80.41) == .zero)
    let immediate = PetDockTransition(fromFrame: settledLeft.frame, toFrame: nextTop.frame, startedAt: 90,
        duration: 0, initialVelocity: CGVector(dx: 800, dy: -600))
    precondition(immediate.value(at: 90).frame == nextTop.frame && immediate.velocity(at: 90) == .zero)
    // Every real window stays inside, including old outward placements and all former threshold gaps.
    let topAnchor = PetWindowAnchor(edge: .top, fraction: 0.5)
    let topNormal = PetDockGeometry.inward(.top)
    for gap: CGFloat in [0, 41, 42, 49, 50, 57, 58, 100] {
        let window = NSRect(x: 300, y: 200, width: 500, height: screen.maxY - gap - 200)
        let heldInside = PetDockGeometry.window(window, anchor: topAnchor, in: screen, previousNormal: topNormal)
        let heldOutside = PetDockGeometry.window(window, anchor: topAnchor, in: screen,
            previousNormal: CGVector(dx: -topNormal.dx, dy: -topNormal.dy))
        precondition(heldInside.contact.normal == topNormal)
        precondition(heldOutside.contact.normal == topNormal)
    }
    let leftTopAnchor = PetWindowAnchor(edge: .top, fraction: 0.02)
    for normal in [topNormal, CGVector(dx: -topNormal.dx, dy: -topNormal.dy)] {
        let below = NSRect(x: 300, y: 200, width: 500, height: screen.maxY - 49 - 200)
        let above = NSRect(x: 300, y: 200, width: 500, height: screen.maxY - 51 - 200)
        let a = PetDockGeometry.window(below, anchor: leftTopAnchor, in: screen, previousNormal: normal)
        let b = PetDockGeometry.window(above, anchor: leftTopAnchor, in: screen, previousNormal: normal)
        precondition(a.contact.normal == b.contact.normal && near(a.contact.point.x, b.contact.point.x))
    }
    // Rapid overlapping-window switching always resolves the topmost actual target.
    let back = AttachedWindow(id: 201, pid: 111, appName: "Back", bundleID: nil, title: "", cgBounds: CGRect(x: 100, y: 100, width: 700, height: 500))
    let front = AttachedWindow(id: 202, pid: 222, appName: "Front", bundleID: nil, title: "", cgBounds: CGRect(x: 400, y: 200, width: 700, height: 500))
    for _ in 0..<120 {
        precondition(WindowProbe.target(at: NSPoint(x: 550, y: 450), windows: [front, back], primaryTop: 900)?.id == front.id)
        precondition(WindowProbe.target(at: NSPoint(x: 200, y: 650), windows: [front, back], primaryTop: 900)?.id == back.id)
        precondition(WindowProbe.target(at: NSPoint(x: 1250, y: 750), windows: [front, back], primaryTop: 900) == nil)
    }
    let negativeDisplay = AttachedWindow(id: 203, pid: 333, appName: "Left", bundleID: nil, title: "",
        cgBounds: CGRect(x: -900, y: -120, width: 600, height: 500))
    precondition(WindowProbe.target(at: NSPoint(x: -600, y: 800), windows: [negativeDisplay, front, back], primaryTop: 900)?.id == negativeDisplay.id)
    print("FOLIO label: limbless display card, attached printed features, four-edge upright identity passed")
    print("FOLIO drag: C1 position/velocity retarget, reversal and immediate reduced-motion endpoints passed")
    print("FOLIO windows: always-inward attachment across former clearance thresholds, 360 frontmost/exit route checks and negative-display hit tests passed")
    precondition(BrowserContextIdentity.matches(firstAX, current: movedAX))
    precondition(!BrowserContextIdentity.matches(firstAX, current: otherAX))
    precondition(!BrowserContextIdentity.matches(firstAX, current: nil))
    precondition(BrowserContextIdentity.pageKey("https://example.com/article?a=1#part-one") == "https://example.com/article?a=1")
    precondition(BrowserContextIdentity.pageKey("https://example.com/article?a=1") != BrowserContextIdentity.pageKey("https://example.com/article?a=2"))
    precondition(BrowserContextIdentity.pageKey("https://example.com/app#/article/a") == "https://example.com/app#/article/a")
    precondition(BrowserContextIdentity.pageKey("https://example.com/app#!/article/a") == "https://example.com/app#!/article/a")
    precondition(BrowserContextIdentity.pageKey("https://example.com/app#/article/a") != BrowserContextIdentity.pageKey("https://example.com/app#/article/b"))
    precondition(BrowserContextIdentity.pageKey("https://example.com/app#!/article/a") != BrowserContextIdentity.pageKey("https://example.com/app#!/article/b"))
    precondition(BrowserContextIdentity.webURL("https://example.com/article") != nil)
    for address in ["file:///private/data", "javascript:alert(1)", "https://user:secret@example.com/", "about:blank"] {
        precondition(BrowserContextIdentity.webURL(address) == nil)
    }
    var previewContext: [String: Any] = ["attachmentId": "window-1", "pageRevision": "revision-1",
                                         "url": "https://example.com/article#introduction", "browserWindowId": "10", "browserTabId": "4"]
    let previewTarget = AttachmentPreviewTarget(previewContext)!
    precondition(previewTarget.matches(BrowserPageSnapshot(url: "https://example.com/article#conclusion", title: "文章", browserWindowID: "10", browserTabID: "4")))
    precondition(!previewTarget.matches(BrowserPageSnapshot(url: "https://example.com/article", title: "文章", browserWindowID: "10", browserTabID: "5")))
    precondition(!previewTarget.matches(BrowserPageSnapshot(url: "https://example.com/another", title: "文章", browserWindowID: "10", browserTabID: "4")))
    previewContext["pageRevision"] = "revision-2"
    precondition(AttachmentPreviewTarget(previewContext) != previewTarget)
    previewContext.removeValue(forKey: "attachmentId")
    precondition(AttachmentPreviewTarget(previewContext) == nil)
    let wechat = AttachedWindow(id: 301, pid: 444, appName: "WeChat", bundleID: "com.tencent.flue.WeChatAppEx",
                               title: "窗口标题", cgBounds: bounds)
    let wechatURL = "https://mp.weixin.qq.com/s/test_article-id"
    precondition(WeChatArticleAccessibility.supports(wechat.bundleID))
    precondition(WeChatArticleAccessibility.supports("com.tencent.xinWeChat"))
    precondition(!WeChatArticleAccessibility.supports("com.tencent.other"))
    precondition(WeChatArticleAccessibility.articleURL("http://mp.weixin.qq.com:80/s/test_article-id/?pass_ticket=discard#wechat_redirect") == wechatURL)
    precondition(WeChatArticleAccessibility.articleURL("https://mp.weixin.qq.com/s?sn=aabb&key=discard&idx=1&mid=2&__biz=Mzg%3D#wechat_redirect")
                 == "https://mp.weixin.qq.com/s?__biz=Mzg%3D&mid=2&idx=1&sn=aabb")
    for address in ["https://mp.weixin.qq.com.evil.example/s/article", "https://mp.weixin.qq.com:8080/s/article",
                    "https://mp.weixin.qq.com/mp/profile_ext", "https://mp.weixin.qq.com/s/a/b",
                    "https://mp.weixin.qq.com/s?__biz=A&mid=1&idx=1", "https://mp.weixin.qq.com/s?__biz=A&mid=1&idx=1&sn=a&sn=b"] {
        precondition(WeChatArticleAccessibility.articleURL(address) == nil)
    }
    let articleCandidate = WeChatArticleAccessibility.articleCandidate(areaAddresses: [["https://example.com/toolbar"], [wechatURL, "\(wechatURL)?discard=1"]],
                                                                      windowAddresses: { preconditionFailure("Direct article proof does not query window URL") })
    precondition(articleCandidate?.index == 1 && articleCandidate?.url == wechatURL)
    precondition(WeChatArticleAccessibility.articleCandidate(areaAddresses: [[wechatURL], [wechatURL]], windowAddresses: { [] }) == nil)
    precondition(WeChatArticleAccessibility.articleCandidate(areaAddresses: [[wechatURL, "about:blank"]], windowAddresses: { [wechatURL] }) == nil)
    precondition(WeChatArticleAccessibility.articleCandidate(areaAddresses: [["about:blank"]], windowAddresses: { [wechatURL] }) == nil)
    precondition(WeChatArticleAccessibility.articleCandidate(areaAddresses: [[], []], windowAddresses: { [wechatURL] }) == nil)
    precondition(WeChatArticleAccessibility.articleCandidate(areaAddresses: [[]], windowAddresses: { [wechatURL] })?.url == wechatURL)
    let articleWindow = CGRect(x: 0, y: 0, width: 800, height: 800)
    let articleFrame = CGRect(x: 0, y: 50, width: 800, height: 750)
    let toolbarFrame = CGRect(x: 0, y: 0, width: 800, height: 60)
    precondition(WeChatArticleAccessibility.hasUnambiguousVisibleArea(articleFrame, in: articleWindow, competingFrames: [toolbarFrame]))
    precondition(!WeChatArticleAccessibility.hasUnambiguousVisibleArea(articleFrame, in: articleWindow, competingFrames: [articleFrame]))
    precondition(!WeChatArticleAccessibility.hasUnambiguousVisibleArea(articleFrame, in: articleWindow, competingFrames: [nil]))
    precondition(!WeChatArticleAccessibility.hasUnambiguousVisibleArea(nil, in: articleWindow, competingFrames: [toolbarFrame]))
    precondition(!WeChatArticleAccessibility.hasUnambiguousVisibleArea(articleFrame.offsetBy(dx: 0, dy: 790), in: articleWindow, competingFrames: []))
    precondition(AttachmentMenuLabel.title(for: nil, context: [:]) == "当前吸附 · 屏幕边缘")
    precondition(AttachmentMenuLabel.title(for: wechat, context: ["title": "窗口标题"]) == "当前吸附 · 微信窗口")
    precondition(AttachmentMenuLabel.title(for: wechat, context: ["attachmentId": wechat.token.uuidString, "sourceType": "wechat-article",
                                                                "url": wechatURL, "title": "人工智能文章"]) == "当前吸附 · 公众号 · 人工智能文章")
    let browser = AttachedWindow(id: 302, pid: 445, appName: "Safari", bundleID: "com.apple.Safari", title: "窗口标题", cgBounds: bounds)
    precondition(AttachmentMenuLabel.title(for: browser, context: ["attachmentId": browser.token.uuidString,
                                                                  "url": "https://www.youtube.com/watch?v=1", "title": "AI 视频"]) == "当前吸附 · YouTube · AI 视频")
    precondition(AttachmentMenuLabel.title(for: browser, context: ["attachmentId": browser.token.uuidString,
                                                                  "url": "https://www.xiaohongshu.com/explore/1", "title": "AI 笔记"]) == "当前吸附 · 小红书 · AI 笔记")
    precondition(AttachmentMenuLabel.title(for: browser, context: ["attachmentId": browser.token.uuidString,
                                                                  "url": "https://www.rednote.com/explore/1", "title": "AI 笔记"]) == "当前吸附 · 小红书 · AI 笔记")
    print("FOLIO attachment sources: WeChat article URL validation, private query removal and macOS menu labels passed")
    let browserRectangle = [-640, -180, -40, 220]
    precondition(BrowserContextIdentity.boundsMatch(browserRectangle, expected: bounds))
    precondition(!BrowserContextIdentity.boundsMatch([-620, -180, -20, 220], expected: bounds))
    let rectangleList = NSAppleEventDescriptor.list()
    for (index, coordinate) in browserRectangle.enumerated() {
        rectangleList.insert(NSAppleEventDescriptor(int32: Int32(coordinate)), at: index + 1)
    }
    precondition(BrowserAttentionReader.rectangle(rectangleList) == browserRectangle)
    let qdCoordinates: [Int16] = [-180, -640, 220, -40]
    let qdData = qdCoordinates.withUnsafeBytes { Data($0) }
    let qdRectangle = NSAppleEventDescriptor(descriptorType: DescType(typeQDRectangle), data: qdData)!
    precondition(BrowserAttentionReader.rectangle(qdRectangle) == browserRectangle)
    let browserObject = try! BrowserAttentionReader.object(want: OSType(cWindow), container: .null(),
        form: OSType(formAbsolutePosition), selection: NSAppleEventDescriptor(int32: 1))
    precondition(browserObject.descriptorType == DescType(typeObjectSpecifier))
    precondition(browserObject.forKeyword(AEKeyword(keyAEDesiredClass))?.typeCodeValue == OSType(cWindow))
    precondition(BrowserAttentionReader.quietOptions.rawValue & UInt(kAEDoNotPromptForUserConsent) != 0)
    let originalRevision = "attachment-initial"
    precondition(BrowserContextIdentity.pageRevision(previousKey: nil, previousRevision: originalRevision, newKey: "https://example.com/a") == originalRevision)
    precondition(BrowserContextIdentity.pageRevision(previousKey: "https://example.com/a", previousRevision: originalRevision, newKey: "https://example.com/a") == originalRevision)
    precondition(BrowserContextIdentity.pageRevision(previousKey: "https://example.com/a", previousRevision: originalRevision, newKey: "https://example.com/b") != originalRevision)
    precondition(BrowserContextIdentity.pageRevision(previousKey: BrowserContextIdentity.pageKey("https://example.com/app#/article/a"), previousRevision: originalRevision, newKey: BrowserContextIdentity.pageKey("https://example.com/app#/article/b")) != originalRevision)
    precondition(BrowserAccessibilityReader.excludedRoles.isSuperset(of: ["AXTextField", "AXTextArea", "AXSecureTextField"]))
    precondition(!BrowserAccessibilityReader.excludedRoles.contains("AXStaticText"))
    let browserWindow = AttachedWindow(id: 101, pid: 12345, appName: "Browser", bundleID: "com.google.Chrome", title: "A", cgBounds: bounds)
    let windowsReply = NSAppleEventDescriptor.list(); windowsReply.insert(browserObject, at: 1)
    let tabOne = try! BrowserAttentionReader.object(want: BrowserAttentionReader.code("CrTb"), container: browserObject,
        form: OSType(formUniqueID), selection: NSAppleEventDescriptor(string: "tab-one"))
    let propertySequence = ["pbnd", "ID  ", "acTa", "ID  ", "URL ", "pnam", "ID  ", "acTa", "ID  ", "URL "]
    func browserFixture(finalWindow: String = "window-one", finalTab: String = "tab-one", finalURL: String = "https://example.com/a", safari: Bool = false) throws -> BrowserPageSnapshot {
        var requests = 0
        let chosenWindow = safari ? AttachedWindow(id: 101, pid: 12345, appName: "Safari", bundleID: "com.apple.Safari", title: "A", cgBounds: bounds) : browserWindow
        let properties = safari ? ["pbnd", "ID  ", "cTab", "pidx", "pURL", "pnam", "ID  ", "cTab", "pidx", "pURL"] : propertySequence
        let windowIdentity = safari ? NSAppleEventDescriptor(int32: 42) : NSAppleEventDescriptor(string: "window-one")
        let tabIdentity = safari ? NSAppleEventDescriptor(int32: 1) : NSAppleEventDescriptor(string: "tab-one")
        let values: [NSAppleEventDescriptor] = [windowsReply, rectangleList,
            windowIdentity, tabOne, tabIdentity,
            NSAppleEventDescriptor(string: "https://example.com/a"), NSAppleEventDescriptor(string: "A"),
            safari ? windowIdentity : NSAppleEventDescriptor(string: finalWindow), tabOne,
            safari ? tabIdentity : NSAppleEventDescriptor(string: finalTab), NSAppleEventDescriptor(string: finalURL)]
        return try BrowserAttentionReader.snapshot(chosenWindow) { descriptor in
            defer { requests += 1 }
            precondition(requests < values.count)
            if requests > 0 {
                precondition(descriptor.forKeyword(AEKeyword(keyAEKeyData))?.typeCodeValue == BrowserAttentionReader.code(properties[requests - 1]))
            }
            return values[requests]
        }
    }
    let stableSnapshot = try! browserFixture()
    precondition(stableSnapshot.url == "https://example.com/a" && stableSnapshot.browserTabID == "tab-one")
    precondition((try? browserFixture(finalURL: "https://example.com/a#section")) != nil)
    precondition((try? browserFixture(finalURL: "https://example.com/b")) == nil)
    precondition((try? browserFixture(finalWindow: "window-two")) == nil)
    precondition((try? browserFixture(finalTab: "tab-two")) == nil)
    let safariSnapshot = try! browserFixture(safari: true)
    precondition(safariSnapshot.browserWindowID == "42" && safariSnapshot.browserTabID == "1")
    let revealPage = BrowserPageRevealTarget(snapshot: stableSnapshot)
    let revealWindow = AttachedWindow(id: 101, pid: 12345, appName: "Chrome", bundleID: "com.google.Chrome",
        title: "A", cgBounds: bounds)
    let idCode = BrowserAttentionReader.code("ID  ")
    let tabCode = BrowserAttentionReader.code("CrTb")
    let activeCode = BrowserAttentionReader.code("acTa")
    let activeIndexCode = BrowserAttentionReader.code("acTI")
    let minimizedCode = BrowserAttentionReader.code("pmnd")
    precondition(BrowserAttentionReader.supportsPageReveal("com.google.Chrome.canary"))
    precondition(!BrowserAttentionReader.supportsPageReveal("com.apple.Safari"))
    precondition(revealPage.title == "A" && revealPage.url == "https://example.com/a")
    func chromeRevealFixture(tabs: [String] = ["tab-two", "tab-one"], activeTab: String = "tab-two",
                             originalTabURL: String = "https://example.com/a#introduction", windowMatches: Bool = true,
                             boundsMatch: Bool = true, orderWorks: Bool = true, minimized: Bool = false,
                             alreadyFront: Bool = false, tabIndexMoves: Bool = false,
                             isCurrent: () -> Bool = { true }) -> (Bool?, [OSType]) {
        var orderedFront = alreadyFront, isMinimized = minimized, selectedTab = activeTab, writes: [OSType] = []
        func select(_ descriptor: NSAppleEventDescriptor) -> NSAppleEventDescriptor? {
            descriptor.forKeyword(AEKeyword(keyAEKeyData))
        }
        func container(_ descriptor: NSAppleEventDescriptor) -> NSAppleEventDescriptor {
            descriptor.forKeyword(AEKeyword(keyAEContainer))!
        }
        func kind(_ descriptor: NSAppleEventDescriptor) -> OSType? {
            descriptor.forKeyword(AEKeyword(keyAEDesiredClass))?.typeCodeValue
        }
        func tab(_ id: String) throws -> NSAppleEventDescriptor {
            try BrowserAttentionReader.object(want: tabCode, container: browserObject, form: OSType(formUniqueID),
                selection: NSAppleEventDescriptor(string: id))
        }
        let result = try? BrowserAttentionReader.reveal(revealPage, in: revealWindow, isCurrent: isCurrent, query: { descriptor in
            if kind(descriptor) == tabCode {
                precondition(select(container(descriptor))?.stringValue == revealPage.browserWindowID)
                let result = NSAppleEventDescriptor.list()
                for (index, id) in tabs.enumerated() { result.insert(try tab(id), at: index + 1) }
                return result
            }
            let key = select(descriptor)?.typeCodeValue
            let owner = container(descriptor)
            let ownerID = select(owner)
            if kind(owner) == OSType(cWindow) {
                let isFrontQuery = ownerID?.descriptorType == DescType(typeSInt32)
                if !isFrontQuery { precondition(ownerID?.stringValue == revealPage.browserWindowID) }
                switch key {
                case idCode:
                    if isFrontQuery { precondition(ownerID?.int32Value == 1) }
                    let matches = isFrontQuery ? orderedFront : windowMatches
                    return NSAppleEventDescriptor(string: matches ? revealPage.browserWindowID : "window-two")
                case OSType(pBounds): return boundsMatch ? rectangleList : NSAppleEventDescriptor.list()
                case minimizedCode: return NSAppleEventDescriptor(boolean: isMinimized)
                case activeCode: return try tab(selectedTab)
                default: preconditionFailure("Unexpected window reveal query")
                }
            }
            precondition(kind(owner) == tabCode)
            let index = Int(ownerID?.int32Value ?? 0) - 1
            let resolvedTab = ownerID?.descriptorType == DescType(typeSInt32)
                ? (tabIndexMoves ? "tab-two" : tabs[index]) : ownerID?.stringValue
            switch key {
            case idCode: return NSAppleEventDescriptor(string: resolvedTab ?? "")
            case BrowserAttentionReader.code("URL "):
                return NSAppleEventDescriptor(string: resolvedTab == revealPage.browserTabID ? originalTabURL : revealPage.url)
            default: preconditionFailure("Unexpected tab reveal query")
            }
        }, write: { descriptor, value in
            precondition(select(container(descriptor))?.stringValue == revealPage.browserWindowID)
            let key = select(descriptor)!.typeCodeValue
            writes.append(key)
            switch key {
            case OSType(pIndex): precondition(value.int32Value == 1); orderedFront = orderWorks
            case minimizedCode: precondition(!value.booleanValue); isMinimized = false
            case activeIndexCode: selectedTab = tabs[Int(value.int32Value) - 1]
            default: preconditionFailure("Unexpected Chrome reveal write")
            }
        })
        return (result, writes)
    }
    let restoredChrome = chromeRevealFixture()
    precondition(restoredChrome.0 == true && restoredChrome.1 == [OSType(pIndex), activeIndexCode])
    let alreadySelectedChrome = chromeRevealFixture(activeTab: "tab-one", alreadyFront: true)
    precondition(alreadySelectedChrome.0 == true && alreadySelectedChrome.1.isEmpty)
    let restoredMinimizedChrome = chromeRevealFixture(activeTab: "tab-one", minimized: true)
    precondition(restoredMinimizedChrome.0 == true && restoredMinimizedChrome.1 == [minimizedCode, OSType(pIndex)])
    for missing in [chromeRevealFixture(tabs: ["tab-two"]), chromeRevealFixture(originalTabURL: "https://example.com/b"),
                    chromeRevealFixture(tabIndexMoves: true)] {
        precondition(missing.0 == false && missing.1 == [OSType(pIndex)])
    }
    let reorderedChrome = chromeRevealFixture(orderWorks: false)
    precondition(reorderedChrome.0 == nil && reorderedChrome.1 == [OSType(pIndex)])
    var checks = 0
    for changed in [chromeRevealFixture(windowMatches: false), chromeRevealFixture(boundsMatch: false),
                    chromeRevealFixture(isCurrent: { checks += 1; return checks == 1 })] {
        precondition(changed.0 == nil && changed.1.isEmpty)
    }
    print("FOLIO Chrome page reveal: exact window, minimized restore, reordered tab, URL change, closed tab and stale attachment checks passed")
    let versionProbe = CuratorApp()
    versionProbe.sendContext(); versionProbe.sendContext(["requestId": "test"])
    precondition(versionProbe.contextVersion == 2)
    print("FORME context isolation: first enrichment, unavailable-page revision, window/tab/URL changes and monotonic context versions passed")
    print("FORME geometry: four edges, Chrome title-bar drop regression, metadata bridging and negative-display coordinates passed")
    print("FORME JavaScript dialog origin: exact loopback origin accepted, external/alternate origins rejected")
    print("FORME chat motion: stable endpoints, interruption continuity and reduced-motion completion passed")
    print("FOLIO chat dragging: title hit area and visible-frame bounds on compact and negative-coordinate displays passed")
    print("FORME pet motion: inward edge peek, visible delivery marks, press/drag/blink poses, reversal continuity and reduced-motion rest passed")
    print("FORME pet contact: four real surfaces, small contact-marker offset, free-form continuity, window edge/fraction memory and finite adhesion endpoints passed")
    print("FORME pet redirection: settled contact and in-flight contour/face snapshots retain exact first-frame world coordinates passed")
    print("FORME pet canvas: all 16 edge routes sampled throughout motion and redirection retain contour control points and face inside 72x84 passed")
    print("FORME browser context: attachment identity, page revision keys, safe URL shape, exact bounds, event descriptors and no-prompt flags passed")
} else {
    let application = NSApplication.shared
    let delegate = CuratorApp()
    application.delegate = delegate
    application.run()
}
