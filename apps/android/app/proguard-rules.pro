# kotlinx.serialization and OkHttp ship their own consumer rules.

# Room 2.6 keeps generated database classes, but not their no-argument constructors.
# WorkManager opens WorkDatabase_Impl through Room.getGeneratedImplementation at startup.
# R8 full mode must retain that reflective constructor as well as the class itself.
-keepclassmembers class * extends androidx.room.RoomDatabase {
    public <init>();
}

# Glance constructs checkbox/refresh callbacks by class name, also through a no-arg constructor.
-keepclassmembers public class * implements androidx.glance.appwidget.action.ActionCallback {
    public <init>();
}
