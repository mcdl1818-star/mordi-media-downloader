# בוט Telegram אישי להורדת מדיה — MVP

בוט לימודי ואישי שמקבל קישור מ־YouTube, Instagram, Facebook, X/Twitter,
TikTok או Vimeo ומציע:

- וידאו עד 720p כאשר זמין
- MP3
- גישה למשתמש Telegram יחיד בלבד
- ניקוי קבצים מיד לאחר השליחה
- בדיקת מגבלת 50MB של Telegram

> יש להשתמש בבוט רק לשמירת תוכן שבבעלותך או תוכן שקיבלת הרשאה מפורשת לשמור.

## דרישות

- Node.js 20 ומעלה
- `yt-dlp`
- `ffmpeg`
- Bot Token מ־BotFather

ודא ששני הכלים זמינים:

```powershell
yt-dlp --version
ffmpeg -version
```

## הגדרה

1. צור בוט דרך `@BotFather` ב־Telegram ושמור את ה־token בסוד.
2. העתק את `.env.example` לקובץ `.env`.
3. הוסף את ה־token ואת מזהה המשתמש האישי שלך. אפשר לקבל את המזהה דרך `@userinfobot`.
4. הפעל:

```powershell
node src/index.js
```

שלח `/start` לבוט ולאחר מכן קישור מאחת הפלטפורמות הנתמכות.

## פתרון תקלות ב־Windows

אם PowerShell חוסם את `npm.ps1`, אפשר להשתמש ב־`npm.cmd`:

```powershell
npm.cmd run check
npm.cmd start
```

אם `yt-dlp` או `ffmpeg` אינם ב־PATH, הגדר ב־`.env` נתיבים מלאים, למשל:

```env
YT_DLP_PATH=C:\tools\yt-dlp.exe
FFMPEG_PATH=C:\tools\ffmpeg.exe
```

## היקף הגרסה

הבוט משתמש ב־extractors של `yt-dlp`, ולכן התמיכה תלויה בזמינות התוכן ובשינויים
באתרי המקור. תוכן ציבורי הוא מסלול העבודה הראשי. תוכן פרטי אינו נעקף ודורש
הרשאה וסשן תקף של המשתמש.

## הפעלה בענן ללא מחשב

הפרויקט כולל `Dockerfile` ו־`compose.yaml`. לאחר פריסה חד־פעמית לשרת, המחשב
האישי אינו נדרש והבוט עולה מחדש אוטומטית לאחר reboot.

להוראות מלאות בעברית: [DEPLOY_ORACLE_HE.md](DEPLOY_ORACLE_HE.md).

לפריסה חינמית ללא כרטיס ניתן להשתמש ב־`render.yaml`. השירות החינמי של Render
נרדם כשאין פעילות ומתעורר בעקבות webhook של Telegram, ולכן ההודעה הראשונה
אחרי זמן שקט עשויה להתעכב.
