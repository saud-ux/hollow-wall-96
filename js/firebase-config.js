// ============================================================================
// Hollow — Firebase configuration
// ============================================================================
//
// These values come from:
//   Firebase Console → Project Settings (⚙) → General → Your apps → "</>" web app
//
// They are already filled in for the "hollow-abd0c" project. If you ever move
// the app to a different Firebase project, replace the six values below.
//
// Firebase Web config is NOT a secret — it ships to every browser by design.
// What actually protects the data is firestore.rules. Make sure ADMIN_UID is
// pasted there and the rules are deployed:
//   firebase deploy --only firestore:rules
//
// Required Console setup (already done for this project):
//   • Authentication → Sign-in method → Anonymous      = Enabled
//   • Authentication → Sign-in method → Email/Password = Enabled
//   • Firestore Database created in Production mode
// ============================================================================

export const firebaseConfig = {
  apiKey:            "AIzaSyCww9g2TYL5lh1_FIdSCJqbc3OI7j0-VTI",
  authDomain:        "hollow-abd0c.firebaseapp.com",
  projectId:         "hollow-abd0c",
  storageBucket:     "hollow-abd0c.firebasestorage.app",
  messagingSenderId: "62050760845",
  appId:             "1:62050760845:web:6544053e57e8fae5510ac4"
};

// Version of the Firebase Web SDK loaded from gstatic across the whole site.
// Bump here in one place to upgrade every page at once.
export const FIREBASE_SDK_VERSION = "10.14.1";

// Base URL for the SDK's ES modules. Every page dynamically imports from here.
export const FIREBASE_SDK_BASE =
  `https://www.gstatic.com/firebasejs/${FIREBASE_SDK_VERSION}`;
