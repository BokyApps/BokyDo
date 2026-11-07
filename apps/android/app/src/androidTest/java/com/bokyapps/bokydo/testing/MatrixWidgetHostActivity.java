package com.bokyapps.bokydo.testing;

import android.app.Activity;
import android.appwidget.AppWidgetHost;
import android.appwidget.AppWidgetHostView;
import android.appwidget.AppWidgetManager;
import android.appwidget.AppWidgetProviderInfo;
import android.content.ComponentName;
import android.content.Intent;
import android.os.Bundle;
import android.os.Build;
import android.util.Log;
import android.view.View;
import android.widget.Button;
import android.widget.FrameLayout;
import android.widget.LinearLayout;
import android.widget.TextView;

/** Real framework widget host living in the private test APK's own process and UID. */
public final class MatrixWidgetHostActivity extends Activity {
    private static final String TAG = "BokyDoMatrixHost";
    private static final String APP = "com.bokyapps.bokydo";
    private static final int HOST_ID = 7392;
    private static final int CONFIGURE_TASKS = 17;
    private AppWidgetHost host;
    private AppWidgetManager manager;
    private AppWidgetHostView tasks;
    private AppWidgetHostView habits;
    private int tasksId = AppWidgetManager.INVALID_APPWIDGET_ID;
    private int habitsId = AppWidgetManager.INVALID_APPWIDGET_ID;
    private FrameLayout frame;
    private TextView status;
    private boolean listening;
    private String selected = "Tasks";

    @Override public void onCreate(Bundle savedState) {
        super.onCreate(savedState);
        if (!"ranchu".equals(Build.HARDWARE) && !"goldfish".equals(Build.HARDWARE)) {
            throw new SecurityException("Disposable emulator required");
        }
        LinearLayout layout = new LinearLayout(this);
        layout.setOrientation(LinearLayout.VERTICAL);
        layout.setFitsSystemWindows(true);
        int padding = dp(12);
        layout.setPadding(padding, padding, padding, padding);
        TextView title = new TextView(this);
        title.setText("BokyDo matrix widget host");
        layout.addView(title);
        LinearLayout tabs = new LinearLayout(this);
        tabs.setOrientation(LinearLayout.HORIZONTAL);
        addButton(tabs, "Tasks", view -> show(tasks, "Tasks"));
        addButton(tabs, "Habits", view -> show(habits, "Habits"));
        layout.addView(tabs);
        Button configure = new Button(this);
        configure.setAllCaps(false);
        configure.setText("Configure tasks");
        configure.setOnClickListener(view -> configureTasks());
        layout.addView(configure);
        Button width = new Button(this);
        width.setAllCaps(false);
        width.setText("Check full width");
        width.setOnClickListener(view -> checkFullWidth());
        layout.addView(width);
        status = new TextView(this);
        status.setPadding(0, dp(8), 0, dp(8));
        layout.addView(status);
        frame = new FrameLayout(this);
        frame.setContentDescription("Matrix widget frame");
        layout.addView(frame, new LinearLayout.LayoutParams(-1, dp(320)));
        setContentView(layout);
        if (savedState != null) selected = savedState.getString("selected", "Tasks");
        manager = AppWidgetManager.getInstance(this);
        host = new AppWidgetHost(this, HOST_ID);
        if (getIntent().getBooleanExtra("teardown", false)) {
            host.deleteHost(); finish(); return;
        }
        try {
            host.startListening();
            listening = true;
            tasksId = bind("TodayWidgetReceiver");
            habitsId = bind("HabitWidgetReceiver");
            tasks = create(tasksId);
            habits = create(habitsId);
            show("Habits".equals(selected) ? habits : tasks, selected);
        } catch (RuntimeException error) {
            fail("Could not initialize widgets (" + error.getClass().getSimpleName()
                + "). Grant appwidget bind access to com.bokyapps.bokydo.test first.");
        }
    }

    private void addButton(LinearLayout parent, String text, View.OnClickListener listener) {
        Button button = new Button(this);
        button.setAllCaps(false);
        button.setText(text);
        button.setOnClickListener(listener);
        parent.addView(button, new LinearLayout.LayoutParams(0, -2, 1));
    }

    private int bind(String receiver) {
        ComponentName provider = new ComponentName(APP, APP + "." + receiver);
        // A killed helper process may leave its framework host registered. Reuse those IDs;
        // ordinary repeated NEW_TASK starts enter onNewIntent and never allocate again.
        for (int existing : host.getAppWidgetIds()) {
            AppWidgetProviderInfo info = manager.getAppWidgetInfo(existing);
            if (info != null && provider.equals(info.provider)) return existing;
        }
        int id = host.allocateAppWidgetId();
        Bundle options = new Bundle();
        int width = Math.max(180, (int) (getResources().getDisplayMetrics().widthPixels
            / getResources().getDisplayMetrics().density) - 24);
        options.putInt(AppWidgetManager.OPTION_APPWIDGET_MIN_WIDTH, width);
        options.putInt(AppWidgetManager.OPTION_APPWIDGET_MAX_WIDTH, width);
        options.putInt(AppWidgetManager.OPTION_APPWIDGET_MIN_HEIGHT, 320);
        options.putInt(AppWidgetManager.OPTION_APPWIDGET_MAX_HEIGHT, 320);
        options.putInt(AppWidgetManager.OPTION_APPWIDGET_HOST_CATEGORY,
            AppWidgetProviderInfo.WIDGET_CATEGORY_HOME_SCREEN);
        if (!manager.bindAppWidgetIdIfAllowed(id, provider, options)) {
            host.deleteAppWidgetId(id);
            throw new IllegalStateException("Widget binding permission is required");
        }
        return id;
    }

    private AppWidgetHostView create(int id) {
        AppWidgetProviderInfo info = manager.getAppWidgetInfo(id);
        if (info == null) throw new IllegalStateException("Widget provider is unavailable");
        AppWidgetHostView view = host.createView(this, id, info);
        view.setLayoutParams(new FrameLayout.LayoutParams(-1, -1));
        return view;
    }

    private void show(AppWidgetHostView view, String label) {
        if (view == null) {
            fail("The requested widget is unavailable.");
            return;
        }
        selected = label;
        frame.removeAllViews();
        frame.addView(view);
        status.setText(label + " widget; tasks ID " + tasksId + "; habits ID " + habitsId);
        frame.post(() -> {
            int width = Math.max(1, (int) (frame.getWidth() / getResources().getDisplayMetrics().density));
            view.updateAppWidgetSize(null, width, 320, width, 320);
        });
    }

    private void checkFullWidth() {
        AppWidgetProviderInfo info = manager.getAppWidgetInfo(tasksId);
        if (info == null || (Build.VERSION.SDK_INT >= 31 && info.maxResizeWidth > 0)) {
            fail("Task provider still limits horizontal resizing."); return;
        }
        int available = tasks.getWidth() - tasks.getPaddingLeft() - tasks.getPaddingRight();
        View content = tasks.getChildCount() == 1 ? tasks.getChildAt(0) : null;
        if (available <= dp(360) || content == null || Math.abs(content.getWidth() - available) > dp(2)) {
            fail("Task content did not fill a host wider than 360dp."); return;
        }
        status.setText("Task widget fills full width above 360dp");
    }

    private void configureTasks() {
        if (tasksId == AppWidgetManager.INVALID_APPWIDGET_ID || tasks == null) {
            fail("The tasks widget must be bound before configuration.");
            return;
        }
        try {
            Intent intent = new Intent(AppWidgetManager.ACTION_APPWIDGET_CONFIGURE)
                .setComponent(new ComponentName(APP, APP + ".WidgetConfigActivity"))
                .putExtra(AppWidgetManager.EXTRA_APPWIDGET_ID, tasksId);
            startActivityForResult(intent, CONFIGURE_TASKS);
        } catch (RuntimeException error) {
            fail("Could not open widget configuration (" + error.getClass().getSimpleName() + ").");
        }
    }

    @Override public void onActivityResult(int request, int result, Intent data) {
        super.onActivityResult(request, result, data);
        if (request == CONFIGURE_TASKS) {
            show(tasks, "Tasks");
            Log.i(TAG, result == RESULT_OK ? "Tasks configuration saved." : "Tasks configuration cancelled.");
        }
    }

    @Override public void onNewIntent(Intent intent) {
        super.onNewIntent(intent);
        setIntent(intent);
        if (intent.getBooleanExtra("teardown", false)) {
            host.deleteHost(); finish();
        }
        // Ordinary starts retain this host, both widget IDs, and the selected view.
    }

    @Override public void onSaveInstanceState(Bundle state) {
        state.putString("selected", selected);
        super.onSaveInstanceState(state);
    }

    private int dp(int value) {
        return Math.round(value * getResources().getDisplayMetrics().density);
    }

    private void fail(String message) {
        status.setText("Matrix widget host failed: " + message);
        Log.e(TAG, message);
    }

    @Override public void onDestroy() {
        if (host != null) {
            try {
                if (listening) host.stopListening();
            } catch (RuntimeException error) {
                Log.e(TAG, "Could not release the matrix widget host ("
                    + error.getClass().getSimpleName() + ").");
            }
        }
        super.onDestroy();
    }
}
