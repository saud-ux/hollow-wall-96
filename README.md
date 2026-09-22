# Hollow — جدار الرسائل المباشر

تطبيق ويب لعرض رسائل الزوار مباشرةً على شاشة داخل المقهى، بمناسبة **اليوم الوطني السعودي ٩٦** (٢٣ سبتمبر).

الزائر يمسح رمز QR من الشاشة، يكتب رسالة قصيرة واسمه من جواله، فتظهر الرسالة على الشاشة خلال أقل من ثانية.

---

## المكوّنات

| الملف | الوصف |
|---|---|
| `index.html` | صفحة الزائر — نموذج كتابة الرسالة (للجوال) |
| `screen.html` | شاشة التلفزيون — جدار الرسائل المباشر |
| `admin.html` | لوحة الإشراف — حذف الرسائل غير المناسبة |
| `qr.html` | ورقة QR جاهزة للطباعة بمقاس A4 |
| `firestore.rules` | قواعد الحماية — تُنشر إلى Firebase |
| `netlify.toml` | إعدادات النشر على Netlify |

التقنيات: HTML/CSS/JS خام (ES modules) بدون أي خطوة بناء، و Firebase (Firestore + Auth) عبر الـ CDN، واستضافة ثابتة على Netlify.

---

## خطوات الإعداد

### ١. إنشاء مشروع Firebase

1. افتح [Firebase Console](https://console.firebase.google.com) ثم **Add project**.
2. اختر أي اسم (مثلاً `hollow-cafe`). يمكنك تعطيل Google Analytics.

### ٢. تفعيل المصادقة

من القائمة الجانبية: **Authentication → Sign-in method**، وفعّل طريقتين:

- **Anonymous** — يستخدمها الزوار للكتابة دون تسجيل.
- **Email/Password** — يستخدمها المشرف للدخول إلى `admin.html`.

### ٣. إنشاء حساب المشرف ونسخ الـ UID

1. **Authentication → Users → Add user**.
2. أدخل بريدًا وكلمة مرور قويّة (مثلاً `admin@hollow.cafe`).
3. بعد الإنشاء ستظهر الصفوف في الجدول — انسخ قيمة **User UID** الخاصة بهذا الحساب.
4. افتح `firestore.rules` وضع الـ UID داخل الدالة `adminUid()` بدل `PASTE_ADMIN_UID_HERE`.

### ٤. إنشاء قاعدة البيانات

**Firestore Database → Create database → Production mode**، واختر منطقة قريبة من السعودية (مثل `eur3`).

### ٥. لصق إعدادات Firebase

1. **Project Settings (⚙) → General → Your apps** → أيقونة **`</>`** لتسجيل تطبيق ويب باسم `Hollow`.
2. انسخ قيم `firebaseConfig` الظاهرة.
3. الصقها في [`js/firebase-config.js`](js/firebase-config.js) بدل الخانات `PASTE_..._HERE`.

### ٦. نشر قواعد الحماية

```bash
npm install -g firebase-tools
firebase login
firebase use --add          # اختر مشروعك
firebase deploy --only firestore:rules
```

> ⚠️ لا تنسَ وضع الـ ADMIN_UID في `firestore.rules` **قبل** النشر، وإلا لن يتمكّن أحد من الحذف.

### ٧. النشر على Netlify

**الطريقة السريعة:** اسحب مجلد المشروع كاملًا وأفلته في [app.netlify.com/drop](https://app.netlify.com/drop).

**الطريقة الدائمة:** اربط المستودع من **Add new site → Import an existing project**. الإعدادات تُقرأ تلقائيًا من `netlify.toml` (لا يوجد أمر بناء، ومجلد النشر هو الجذر).

بعد النشر ستحصل على رابط مثل `https://hollow-cafe.netlify.app` — هذا هو الرابط الذي يشفّره رمز QR.

### ٨. تشغيل الشاشة

افتح على جهاز التلفزيون:

```
https://YOUR-SITE.netlify.app/screen.html?kiosk=1
```

- `?kiosk=1` تُخفي مؤشر الفأرة.
- اضغط **F11** لملء الشاشة.
- الشاشة تعمل أفقيًا (1080p أو 4K) وعموديًا تلقائيًا، وتمنع الجهاز من السكون أثناء عرضها.
- عند انقطاع الإنترنت تظهر شارة صغيرة «إعادة الاتصال…» وتختفي وحدها عند عودة الشبكة — لا حاجة لتحديث الصفحة.

**للفحص في الموقع قبل الفعالية:** `screen.html?debug=1` يفعّل سجلات مفصّلة ويتيح في Console:

- `hollow.state()` — حالة الاتصال وعدد البطاقات
- `hollow.offline()` / `hollow.online()` — محاكاة انقطاع الشبكة
- `hollow.preview([{ text: "…", name: "…" }])` — معاينة شكل رسائل طويلة أو قصيرة على الشاشة الفعلية (محليًا فقط، لا تُحفظ)
- لتشغيل تلقائي عند الإقلاع (Chrome):

```bash
chrome --kiosk --incognito --noerrdialogs --disable-session-crashed-bubble "https://YOUR-SITE.netlify.app/screen.html?kiosk=1"
```

### ٩. لوحة الإشراف

`https://YOUR-SITE.netlify.app/admin.html` — سجّل الدخول بحساب المشرف المُنشأ في الخطوة ٣.
الصفحة تحمل `noindex` ولا يُشار إليها من أي صفحة أخرى.

### ١٠. ورقة QR للطباعة

`https://YOUR-SITE.netlify.app/qr.html` ثم زر الطباعة — مقاس A4.

---

## ملاحظات تشغيلية

- **حد الإرسال:** رسالة واحدة كل ٤٥ ثانية لكل جهاز، مطبّقة في الواجهة وفي قواعد الحماية معًا.
- **الشاشة** تقرأ أحدث ١٢ رسالة فقط عبر مستمع واحد، فلا يزيد استهلاك القراءات مع ازدياد الحضور.
- **بعد الفعالية:** استخدم زر «حذف الكل» في لوحة الإشراف للتنظيف.

---

## حالة البناء

- [x] المرحلة ١ — الهيكل والإعدادات والقواعد
- [x] المرحلة ٢ — صفحة الزائر
- [x] المرحلة ٣ — شاشة العرض المباشرة
- [x] المرحلة ٤ — لوحة الإشراف
- [ ] المرحلة ٥ — التصميم النهائي والمراجعة
