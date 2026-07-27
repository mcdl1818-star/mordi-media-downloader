# פריסה חינמית ל־Oracle Cloud

לאחר השלמת השלבים הבוט רץ בענן באופן עצמאי. המחשב האישי יכול להיות כבוי.

## 1. פתיחת שרת

1. פתח חשבון Oracle Cloud Free Tier.
2. צור Compute Instance המסומן `Always Free eligible`.
3. בחר Ubuntu 24.04. מכונת Ampere ARM מתאימה ל־Docker ולפרויקט.
4. שמור את מפתח ה־SSH הפרטי שמתקבל בזמן יצירת המכונה.
5. אין צורך לפתוח פורטים נכנסים לבוט. הוא פונה בעצמו ל־Telegram ב־HTTPS.

Oracle עשויה לבקש אמצעי תשלום לאימות. יש לוודא במסך העלות שהמשאב מסומן
Always Free ושעלות ההקמה היא אפס.

## 2. התחברות והתקנת Docker

התחבר לכתובת הציבורית של המכונה:

```powershell
ssh -i C:\path\to\private-key.key ubuntu@SERVER_IP
```

בתוך השרת:

```bash
sudo apt-get update
sudo apt-get install -y docker.io docker-compose-v2 git
sudo usermod -aG docker "$USER"
exit
```

התחבר מחדש כדי שהרשאת Docker תיכנס לתוקף.

## 3. העברת הפרויקט

אפשר לשמור את הפרויקט במאגר Git פרטי ולשכפל אותו לשרת. אין להעלות את `.env`.
אפשר גם להעביר את התיקייה ישירות:

```powershell
scp -i C:\path\to\private-key.key -r "C:\Users\ml054\Documents\הורדה מיוטיוב" ubuntu@SERVER_IP:~/telegram-bot
```

## 4. יצירת סודות בשרת

בתוך תיקיית הפרויקט בשרת:

```bash
cp .env.example .env
nano .env
chmod 600 .env
```

יש להגדיר:

```env
TELEGRAM_BOT_TOKEN=הטוקן_מ־BotFather
ALLOWED_TELEGRAM_USER_ID=מזהה_המשתמש_שלך
YT_DLP_PATH=yt-dlp
FFMPEG_PATH=ffmpeg
MAX_FILE_SIZE_MB=49
TEMP_TTL_MINUTES=30
```

## 5. הפעלה

```bash
docker compose up -d --build
docker compose logs -f --tail=100
```

כאשר מופיעה ההודעה `הבוט פעיל וממתין להודעות`, שלח `/start` ב־Telegram.
אפשר לצאת מ־SSH; הקונטיינר ממשיך לפעול.

## תחזוקה

בדיקת מצב:

```bash
docker compose ps
docker compose logs --tail=100
```

עדכון לאחר שינוי בקוד:

```bash
docker compose up -d --build
```

עדכון `yt-dlp` נעשה בבנייה מחדש של התמונה. מומלץ לבנות מחדש מדי פעם, מכיוון
שאתרי וידאו משתנים ולעיתים דורשים גרסת extractor עדכנית.

## פרטיות ועלויות

- אין לפתוח פורטים 3000 או 80; הבוט משתמש ב־long polling יוצא בלבד.
- רק מזהה Telegram המוגדר ב־`.env` מורשה להשתמש בו.
- ה־token נשמר רק בשרת ולא בתמונה או במאגר Git.
- בדוק מדי פעם את מסך Billing ב־Oracle. שירות חינמי אינו התחייבות נצחית,
  ו־Oracle מציינת שמכונות Always Free שאינן פעילות עשויות להימחק.
