import BackgroundTasks
import SwiftRs
import Tauri
import UIKit
import WebKit

class HapticArgs: Decodable {
  let style: String
}

class RefreshDoneArgs: Decodable {
  let ok: Bool
}

class PhonePlugin: Plugin {
  static let refreshTask = "au.com.talkk.shift.refresh"

  /// Guards the refresh state below: Tauri calls commands on its IPC queue, BGTaskScheduler on its own.
  private let queue = DispatchQueue(label: "shift.phone")
  /// Rust's standing request for the next refresh (nextRefresh), answered when iOS runs one.
  private var waiting: Invoke?
  private var task: BGAppRefreshTask?

  override init() {
    super.init()
    // iOS only accepts the handler before the app finishes launching; Tauri creates plugins before that.
    BGTaskScheduler.shared.register(forTaskWithIdentifier: Self.refreshTask, using: nil) { [weak self] task in
      self?.started(task as! BGAppRefreshTask)
    }
    NotificationCenter.default.addObserver(
      forName: UIApplication.didEnterBackgroundNotification, object: nil, queue: nil
    ) { [weak self] _ in self?.schedule() }
  }

  override func load(webview: WKWebView) {
    DispatchQueue.main.async { Self.hideAccessoryBar(webview) }
  }

  /// WebKit puts a ^ v ✓ bar on the keyboard for every field; Mail has none, and the compose sheet's own format bar
  /// sits there. The bar is the content view's inputAccessoryView, so the view gets a subclass that returns nil.
  private static func hideAccessoryBar(_ webview: WKWebView) {
    guard
      let content = webview.scrollView.subviews.first(where: {
        String(describing: type(of: $0)).hasPrefix("WKContent")
      })
    else { return }
    let base: AnyClass = type(of: content)
    let name = "\(base)_ShiftNoAccessory"
    var sub: AnyClass? = NSClassFromString(name)
    if sub == nil, let made = objc_allocateClassPair(base, name, 0) {
      let none: @convention(block) (AnyObject) -> AnyObject? = { _ in nil }
      let sel = #selector(getter: UIResponder.inputAccessoryView)
      if let method = class_getInstanceMethod(UIView.self, sel) {
        class_addMethod(made, sel, imp_implementationWithBlock(none), method_getTypeEncoding(method))
      }
      objc_registerClassPair(made)
      sub = made
    }
    if let sub = sub { object_setClass(content, sub) }
  }

  @objc public func haptic(_ invoke: Invoke) throws {
    let style = try invoke.parseArgs(HapticArgs.self).style
    DispatchQueue.main.async {
      switch style {
      case "selection": UISelectionFeedbackGenerator().selectionChanged()
      case "success": UINotificationFeedbackGenerator().notificationOccurred(.success)
      case "warning": UINotificationFeedbackGenerator().notificationOccurred(.warning)
      case "medium": UIImpactFeedbackGenerator(style: .medium).impactOccurred()
      default: UIImpactFeedbackGenerator(style: .light).impactOccurred()
      }
    }
    invoke.resolve()
  }

  /// Answers when iOS gives the app a background refresh; Rust then syncs and calls refreshDone.
  @objc public func nextRefresh(_ invoke: Invoke) {
    queue.async {
      if self.task != nil { invoke.resolve() } else { self.waiting = invoke }
    }
  }

  @objc public func refreshDone(_ invoke: Invoke) throws {
    let ok = try invoke.parseArgs(RefreshDoneArgs.self).ok
    queue.async { self.finish(ok) }
    invoke.resolve()
  }

  private func started(_ task: BGAppRefreshTask) {
    queue.async {
      self.task = task
      task.expirationHandler = { [weak self] in self?.queue.async { self?.finish(false) } }
      self.waiting?.resolve()
      self.waiting = nil
    }
  }

  private func finish(_ ok: Bool) {
    task?.setTaskCompleted(success: ok)
    task = nil
    schedule()
  }

  /// Asks for the next refresh. iOS decides when (often not for hours, sooner for apps used often), so this is a floor.
  private func schedule() {
    let request = BGAppRefreshTaskRequest(identifier: Self.refreshTask)
    request.earliestBeginDate = Date(timeIntervalSinceNow: 15 * 60)
    try? BGTaskScheduler.shared.submit(request)
  }
}

@_cdecl("init_plugin_phone")
public func initPlugin() -> Plugin {
  return PhonePlugin()
}
