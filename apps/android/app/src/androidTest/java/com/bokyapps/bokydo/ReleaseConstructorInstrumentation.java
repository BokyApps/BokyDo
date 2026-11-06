package com.bokyapps.bokydo;

import android.app.Activity;
import android.app.Instrumentation;
import android.content.Context;
import android.os.Bundle;
import android.util.Log;

/** Platform-only harness for an actual minified, signed APK. AndroidJUnitRunner's shared
 * dependencies assume an unshrunk target, so they must not be used for this release gate.
 * Sign this private test APK with the target certificate; never publish it.
 */
public final class ReleaseConstructorInstrumentation extends Instrumentation {
    @Override public void onCreate(Bundle arguments) {
        super.onCreate(arguments);
        start();
    }

    @Override public void onStart() {
        Bundle result = new Bundle();
        try {
            ClassLoader loader = getTargetContext().getClassLoader();
            String[] callbacks = {
                "androidx.work.impl.WorkDatabase_Impl",
                "com.bokyapps.bokydo.CompleteTaskAction",
                "com.bokyapps.bokydo.HabitCheckInAction",
                "com.bokyapps.bokydo.RefreshWidgetsAction"
            };
            for (String name : callbacks) {
                Object instance = loader.loadClass(name).getDeclaredConstructor().newInstance();
                if (instance == null) throw new AssertionError(name);
            }
            Class<?> parameters = loader.loadClass("androidx.work.WorkerParameters");
            String[] workers = {
                "com.bokyapps.bokydo.SyncWorker", "androidx.glance.session.SessionWorker"
            };
            for (String name : workers) {
                loader.loadClass(name).getDeclaredConstructor(Context.class, parameters);
            }
            result.putString("stream", "PASS: six reflective constructors survive in the installed signed release");
            finish(Activity.RESULT_OK, result);
        } catch (Throwable error) {
            result.putString("stream", "FAIL: " + Log.getStackTraceString(error));
            finish(Activity.RESULT_CANCELED, result);
        }
    }
}
