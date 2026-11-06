package com.bokyapps.bokydo;

import android.accessibilityservice.AccessibilityServiceInfo;
import android.app.Activity;
import android.app.Instrumentation;
import android.app.UiAutomation;
import android.content.ComponentName;
import android.content.Intent;
import android.os.Build;
import android.os.Bundle;
import android.os.SystemClock;
import android.view.KeyEvent;
import android.view.accessibility.AccessibilityNodeInfo;
import java.util.ArrayList;
import java.util.List;

/** Black-box matrix controller: framework Java only, against the exact installed release.
 * A privately signed test browser/host runs in the helper package, just like external apps.
 */
public final class ReleaseMatrixInstrumentation extends Instrumentation {
    private static final String APP = "com.bokyapps.bokydo";
    private static final String HELPERS = APP + ".test";
    private final List<String> passed = new ArrayList<>();
    private UiAutomation ui;
    private Bundle arguments;
    private interface Match { boolean test(AccessibilityNodeInfo node); }

    @Override public void onCreate(Bundle args) {
        super.onCreate(args);
        arguments = args == null ? new Bundle() : args;
        start();
    }

    @Override public void onStart() {
        Bundle result = new Bundle();
        try {
            if (!"ranchu".equals(Build.HARDWARE) && !"goldfish".equals(Build.HARDWARE)) {
                throw new SecurityException("Disposable emulator required");
            }
            // Select the controlled fixture browser without depending on the emulator's
            // asynchronous RoleController service. Preserve the app's actual OAuth intent.
            addMonitor(new ActivityMonitor() {
                @Override public ActivityResult onStartActivity(Intent intent) {
                    android.net.Uri uri = intent.getData();
                    if (Intent.ACTION_VIEW.equals(intent.getAction()) && uri != null
                        && "http".equals(uri.getScheme()) && "127.0.0.1".equals(uri.getHost())
                        && uri.getPort() == 18090 && "/oauth/authorize".equals(uri.getPath())) {
                        intent.setComponent(new ComponentName(HELPERS, APP + ".testing.FixtureBrowserActivity"));
                        intent.setPackage(HELPERS);
                    }
                    return null;
                }
            });
            ui = getUiAutomation();
            AccessibilityServiceInfo service = ui.getServiceInfo();
            service.flags |= AccessibilityServiceInfo.FLAG_REPORT_VIEW_IDS
                | AccessibilityServiceInfo.FLAG_RETRIEVE_INTERACTIVE_WINDOWS;
            ui.setServiceInfo(service);
            if ("true".equals(arguments.getString("widgetsOnly"))) {
                widgets();
            } else {
                signIn();
                tasks();
                widgets();
            }
            result.putString("stream", "PASS Android API " + Build.VERSION.SDK_INT + ": " + String.join(", ", passed));
            finish(Activity.RESULT_OK, result);
        } catch (Throwable error) {
            result.putString("stream", "FAIL Android API " + Build.VERSION.SDK_INT + ": "
                + android.util.Log.getStackTraceString(error) + "\nVisible: " + visible());
            finish(Activity.RESULT_CANCELED, result);
        }
    }

    private void step(String name) {
        passed.add(name);
        Bundle status = new Bundle();
        status.putString("stream", "API " + Build.VERSION.SDK_INT + ": " + name + "\n");
        sendStatus(1, status);
    }

    private void open(String pkg, String activity) {
        Intent intent = new Intent().setComponent(new ComponentName(pkg, activity))
            .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_REORDER_TO_FRONT);
        getContext().startActivity(intent);
    }

    private void signIn() throws Exception {
        open(APP, APP + ".MainActivity");
        waitFor(n -> text(n, "Server address"), "connect screen").recycle();
        AccessibilityNodeInfo input = waitFor(AccessibilityNodeInfo::isEditable, "server input");
        Bundle value = new Bundle();
        value.putCharSequence(AccessibilityNodeInfo.ACTION_ARGUMENT_SET_TEXT_CHARSEQUENCE, "http://127.0.0.1:18090");
        if (!input.performAction(AccessibilityNodeInfo.ACTION_SET_TEXT, value)) throw new AssertionError("Set server address");
        input.recycle();
        click("Continue");
        click("Continue anyway");
        waitFor(n -> text(n, "Today fixture"), "signed-in task sync").recycle();
        step("native OAuth sign-in and initial task sync");
    }

    private void tasks() throws Exception {
        clickNavigation("Inbox");
        waitFor(n -> text(n, "Inbox fixture"), "Inbox tasks").recycle();
        click("Add task");
        AccessibilityNodeInfo edit = waitFor(AccessibilityNodeInfo::isEditable, "quick-add field");
        Bundle value = new Bundle();
        String title = "Matrix task api" + Build.VERSION.SDK_INT;
        value.putCharSequence(AccessibilityNodeInfo.ACTION_ARGUMENT_SET_TEXT_CHARSEQUENCE, title);
        if (!edit.performAction(AccessibilityNodeInfo.ACTION_SET_TEXT, value)) throw new AssertionError("Set task name");
        edit.recycle();
        dismissKeyboard();
        click("Add task");
        waitFor(n -> String.valueOf(n.getText()).contains("Added “"), "task creation acknowledgement").recycle();
        dismissKeyboard();
        back();
        waitFor(n -> text(n, title), "new task row").recycle();
        step("quick add and task rendering");
    }

    private void widgets() throws Exception {
        open(HELPERS, APP + ".testing.MatrixWidgetHostActivity");
        waitFor(n -> text(n, "Configure tasks"), "widget host").recycle();
        String[][] views = {
            {"Inbox", "Inbox fixture", "Inbox", "Project fixture"},
            {"Today (overdue and today)", "Today fixture", "Today", "Inbox fixture", "Upcoming fixture", "Project fixture"},
            {"Upcoming (two weeks)", "Upcoming fixture", "Upcoming", "Inbox fixture", "Today fixture", "Project fixture"},
            {"Widget project", "Project fixture", "Widget project", "Inbox fixture", "Today fixture", "Upcoming fixture"}
        };
        for (String[] view : views) {
            click("Configure tasks");
            click(view[0]);
            click("Save");
            waitFor(n -> text(n, view[2]), "widget header " + view[2]).recycle();
            waitFor(n -> text(n, view[1]), "widget " + view[0]).recycle();
            for (int i = 3; i < view.length; i++) {
                final String excluded = view[i];
                waitAbsent(n -> text(n, excluded), "excluded task " + excluded);
            }
        }
        step("Inbox, Today, Upcoming and project widgets");
        AccessibilityNodeInfo task = waitFor(n -> n.isCheckable() && text(n, "Project fixture"), "task widget checkbox");
        clickNode(task);
        waitAbsent(n -> text(n, "Project fixture"), "completed task removal");
        step("task widget completion and redraw");
        click("Habits");
        AccessibilityNodeInfo habit = waitFor(n -> n.isCheckable() && text(n, "Daily widget habit"), "habit widget checkbox");
        boolean previous = habit.isChecked();
        clickNode(habit);
        waitFor(n -> n.isCheckable() && text(n, "Daily widget habit") && n.isChecked() != previous,
            "habit checkbox state").recycle();
        String progress = previous ? "0/1 today" : "1/1 today";
        waitFor(n -> text(n, progress), "confirmed habit progress").recycle();
        step("habit widget check-in, progress and redraw");
        clickNode(waitFor(n -> text(n, "Habits") && !String.valueOf(n.getClassName()).contains("Button") && clickable(n), "habit widget header"));
        waitFor(n -> text(n, "Manage habits"), "native Habits screen").recycle();
        step("widget-to-native Habits navigation");
    }

    private static boolean text(AccessibilityNodeInfo node, String value) {
        return value.contentEquals(node.getText() == null ? "" : node.getText())
            || value.contentEquals(node.getContentDescription() == null ? "" : node.getContentDescription());
    }

    private AccessibilityNodeInfo search(AccessibilityNodeInfo node, Match match) {
        if (node == null) return null;
        if (node.isVisibleToUser() && match.test(node)) return AccessibilityNodeInfo.obtain(node);
        for (int i = 0; i < node.getChildCount(); i++) {
            AccessibilityNodeInfo child = node.getChild(i);
            if (child == null) continue;
            AccessibilityNodeInfo found = search(child, match);
            child.recycle();
            if (found != null) return found;
        }
        return null;
    }

    private AccessibilityNodeInfo find(Match match) {
        AccessibilityNodeInfo root = ui.getRootInActiveWindow();
        if (root == null) return null;
        try { return search(root, match); } finally { root.recycle(); }
    }

    private AccessibilityNodeInfo waitFor(Match match, String label) throws Exception {
        long until = SystemClock.uptimeMillis() + 120_000;
        while (SystemClock.uptimeMillis() < until) {
            AccessibilityNodeInfo found = find(match);
            if (found != null) return found;
            AccessibilityNodeInfo travel = find(n -> text(n, "Not now") && clickable(n));
            if (travel != null) clickNode(travel);
            Thread.sleep(300);
        }
        throw new AssertionError("Timeout: " + label);
    }

    private void waitAbsent(Match match, String label) throws Exception {
        long until = SystemClock.uptimeMillis() + 90_000;
        while (SystemClock.uptimeMillis() < until) {
            AccessibilityNodeInfo found = find(match);
            if (found == null) return;
            found.recycle();
            Thread.sleep(300);
        }
        throw new AssertionError("Timeout: " + label);
    }

    private static boolean clickable(AccessibilityNodeInfo node) {
        AccessibilityNodeInfo cursor = AccessibilityNodeInfo.obtain(node);
        try {
            for (int i = 0; cursor != null && i < 5; i++) {
                if (cursor.isClickable() && cursor.isEnabled()) return true;
                AccessibilityNodeInfo parent = cursor.getParent();
                cursor.recycle(); cursor = parent;
            }
            return false;
        } finally { if (cursor != null) cursor.recycle(); }
    }

    // Project names inside task rows can equal navigation labels. The fixed bottom bar's
    // matching label is below those rows; choose it rather than the first textual match.
    private AccessibilityNodeInfo bottomNavigation(AccessibilityNodeInfo node, String label) {
        if (node == null) return null;
        AccessibilityNodeInfo best = node.isVisibleToUser() && text(node, label) && clickable(node)
            ? AccessibilityNodeInfo.obtain(node) : null;
        android.graphics.Rect bestBounds = new android.graphics.Rect();
        if (best != null) best.getBoundsInScreen(bestBounds);
        for (int i = 0; i < node.getChildCount(); i++) {
            AccessibilityNodeInfo child = node.getChild(i);
            if (child == null) continue;
            AccessibilityNodeInfo candidate = bottomNavigation(child, label);
            child.recycle();
            if (candidate == null) continue;
            android.graphics.Rect bounds = new android.graphics.Rect();
            candidate.getBoundsInScreen(bounds);
            if (best == null || bounds.bottom > bestBounds.bottom) {
                if (best != null) best.recycle();
                best = candidate; bestBounds.set(bounds);
            } else candidate.recycle();
        }
        return best;
    }

    private void clickNavigation(String label) throws Exception {
        waitFor(n -> text(n, label) && clickable(n), "navigation " + label).recycle();
        AccessibilityNodeInfo root = ui.getRootInActiveWindow();
        if (root == null) throw new AssertionError("No active navigation window");
        AccessibilityNodeInfo target;
        try { target = bottomNavigation(root, label); } finally { root.recycle(); }
        if (target == null) throw new AssertionError("Missing navigation " + label);
        clickNode(target);
    }

    private void click(String label) throws Exception {
        clickNode(waitFor(n -> text(n, label) && clickable(n), label));
    }

    private void clickNode(AccessibilityNodeInfo node) {
        AccessibilityNodeInfo cursor = node;
        try {
            for (int i = 0; cursor != null && i < 5; i++) {
                if (cursor.isClickable() && cursor.isEnabled()) {
                    if (!cursor.performAction(AccessibilityNodeInfo.ACTION_CLICK)) throw new AssertionError("Click rejected");
                    return;
                }
                AccessibilityNodeInfo parent = cursor.getParent();
                cursor.recycle(); cursor = parent;
            }
            throw new AssertionError("No clickable node");
        } finally { if (cursor != null) cursor.recycle(); }
    }

    private void dismissKeyboard() {
        boolean shown = false;
        for (android.view.accessibility.AccessibilityWindowInfo window : ui.getWindows()) {
            shown |= window.getType() == android.view.accessibility.AccessibilityWindowInfo.TYPE_INPUT_METHOD;
            window.recycle();
        }
        if (shown) back();
    }

    private void back() {
        long now = SystemClock.uptimeMillis();
        ui.injectInputEvent(new KeyEvent(now, now, KeyEvent.ACTION_DOWN, KeyEvent.KEYCODE_BACK, 0), true);
        ui.injectInputEvent(new KeyEvent(now, now, KeyEvent.ACTION_UP, KeyEvent.KEYCODE_BACK, 0), true);
        SystemClock.sleep(300);
    }

    private String visible() {
        if (ui == null) return "unavailable";
        List<String> lines = new ArrayList<>();
        AccessibilityNodeInfo root = ui.getRootInActiveWindow();
        if (root != null) { describe(root, lines); root.recycle(); }
        return String.join(" | ", lines);
    }

    private void describe(AccessibilityNodeInfo node, List<String> lines) {
        String value = String.valueOf(node.getText());
        if (!"null".equals(value) && !value.isEmpty() && !node.isPassword()) lines.add(value.substring(0, Math.min(value.length(), 150)));
        for (int i = 0; i < node.getChildCount(); i++) {
            AccessibilityNodeInfo child = node.getChild(i);
            if (child != null) { describe(child, lines); child.recycle(); }
        }
    }
}
