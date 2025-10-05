require('dotenv').config();
const TelegramBot = require('node-telegram-bot-api');
const sqlite3 = require('sqlite3').verbose();
const Anthropic = require('@anthropic-ai/sdk').Anthropic;
const cron = require('node-cron');
const axios = require('axios');
const FormData = require('form-data');

console.log('🚀 Запуск продвинутого бота...');
console.log('📊 Переменные окружения:');
console.log('- TELEGRAM_TOKEN:', process.env.TELEGRAM_TOKEN ? '✅ загружен' : '❌ отсутствует');
console.log('- CLAUDE_API_KEY:', process.env.CLAUDE_API_KEY ? '✅ загружен' : '❌ отсутствует');
console.log('- FIREWORKS_API_KEY:', process.env.FIREWORKS_API_KEY ? '✅ загружен' : '❌ отсутствует');

// Инициализация API
const anthropic = new Anthropic({
  apiKey: process.env.CLAUDE_API_KEY,
});

const bot = new TelegramBot(process.env.TELEGRAM_TOKEN, { polling: true });

// Инициализация базы данных
const db = new sqlite3.Database('/app/data/calorie_bot.db');

// Создание таблиц при запуске
db.serialize(() => {
  db.run(`DROP TABLE IF EXISTS daily_limits`);
  db.run(`DROP TABLE IF EXISTS food_entries`);  
  db.run(`DROP TABLE IF EXISTS users`);
  
  db.run(`CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY,
    telegram_id INTEGER UNIQUE,
    first_name TEXT,
    daily_goal INTEGER DEFAULT 2000,
    goal_set BOOLEAN DEFAULT FALSE,
    purchased_analyses INTEGER DEFAULT 0,
    unlimited_until DATE,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )`);
  
  db.run(`CREATE TABLE IF NOT EXISTS food_entries (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER,
    date DATE,
    description TEXT,
    calories INTEGER,
    analysis_method TEXT DEFAULT 'claude',
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (user_id) REFERENCES users (id)
  )`);

  db.run(`CREATE TABLE IF NOT EXISTS daily_limits (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER,
    date DATE,
    requests_count INTEGER DEFAULT 0,
    FOREIGN KEY (user_id) REFERENCES users (id),
    UNIQUE(user_id, date)
  )`);
  
  console.log('✅ База данных пересоздана с правильной структурой (+ unlimited_until)');
});

// ============= HELPER ФУНКЦИИ =============

// Helper функция для получения имени пользователя (async)
async function getUserNameAsync(telegramId) {
  return new Promise((resolve) => {
    getUserName(telegramId, (err, name) => {
      resolve(err ? 'друг' : name);
    });
  });
}

// Функция для расшифровки аудио через Fireworks AI
async function transcribeAudio(audioBuffer, fileName) {
  try {
    console.log('🎤 Отправляю аудио в Fireworks AI для расшифровки...');
    
    const formData = new FormData();
    formData.append('file', audioBuffer, fileName);
    formData.append('model', 'accounts/fireworks/models/whisper-v3-turbo');
    formData.append('language', 'ru');
    
    const response = await axios.post('https://api.fireworks.ai/inference/v1/audio/transcriptions', formData, {
      headers: {
        'Authorization': `Bearer ${process.env.FIREWORKS_API_KEY}`,
        ...formData.getHeaders()
      },
      timeout: 30000
    });
    
    const transcription = response.data.text;
    console.log('✅ Расшифровка получена:', transcription);
    return transcription;
    
  } catch (error) {
    console.error('❌ Ошибка расшифровки:', error.response?.data || error.message);
    throw new Error('Не удалось расшифровать аудио');
  }
}

// Альтернативный метод расшифровки
async function transcribeAudioAlternative(audioBuffer, fileName) {
  try {
    console.log('🔄 Альтернативная расшифровка без параметра языка...');
    
    const formData = new FormData();
    formData.append('file', audioBuffer, {
      filename: fileName,
      contentType: 'audio/ogg'
    });
    
    const response = await axios.post('https://audio-prod.us-virginia-1.direct.fireworks.ai/v1/audio/transcriptions', formData, {
      headers: {
        'Authorization': `Bearer ${process.env.FIREWORKS_API_KEY}`,
        ...formData.getHeaders()
      },
      timeout: 45000
    });
    
    const transcription = response.data.text || response.data.transcription || response.data.result;
    
    if (!transcription || transcription.trim().length === 0) {
      throw new Error('Альтернативная расшифровка пуста');
    }
    
    return transcription.trim();
    
  } catch (error) {
    console.error('❌ Ошибка альтернативной расшифровки:', error.response?.data || error.message);
    throw error;
  }
}

// Функция для расшифровки голосового с fallback
async function transcribeAudioWithFallback(audioBuffer, fileName) {
  console.log('🎤 Начинаю полную расшифровку с fallback...');
  
  try {
    console.log('📡 Пробую основную whisper-v3...');
    const transcription = await transcribeAudio(audioBuffer, fileName);
    
    if (transcription && transcription.trim().length > 0) {
      console.log('✅ Основная расшифровка успешна:', transcription);
      return transcription;
    }
  } catch (error) {
    console.log('⚠️ Основная расшифровка не сработала:', error.message);
  }
  
  try {
    console.log('🔄 Пробую альтернативный метод...');
    const fallbackTranscription = await transcribeAudioAlternative(audioBuffer, fileName);
    
    if (fallbackTranscription && fallbackTranscription.trim().length > 0) {
      console.log('✅ Fallback расшифровка успешна:', fallbackTranscription);
      return fallbackTranscription;
    }
  } catch (error) {
    console.log('❌ Fallback тоже не сработал:', error.message);
  }
  
  throw new Error('Не удалось расшифровать аудио ни одним способом');
}

// Функция для скачивания файла от Telegram
async function downloadTelegramFile(fileId) {
  try {
    console.log('📥 Скачиваю файл от Telegram:', fileId);
    
    const fileInfo = await bot.getFile(fileId);
    const filePath = fileInfo.file_path;
    
    const fileUrl = `https://api.telegram.org/file/bot${process.env.TELEGRAM_TOKEN}/${filePath}`;
    const response = await axios.get(fileUrl, { responseType: 'arraybuffer' });
    
    console.log('✅ Файл скачан, размер:', response.data.length, 'байт');
    return Buffer.from(response.data);
    
  } catch (error) {
    console.error('❌ Ошибка скачивания файла:', error.message);
    throw new Error('Не удалось скачать аудио файл');
  }
}

// Функция для парсинга значений калорий (обрабатывает диапазоны)
function parseCalorieValue(value) {
  if (typeof value === 'number') {
    return Math.round(value);
  }
  
  if (typeof value === 'string') {
    const cleanValue = value.replace(/[^\d\-.,]/g, '');
    
    const rangeMatch = cleanValue.match(/^(\d+(?:\.\d+)?)\s*[-—]\s*(\d+(?:\.\d+)?)$/);
    if (rangeMatch) {
      const min = parseFloat(rangeMatch[1]);
      const max = parseFloat(rangeMatch[2]);
      const average = (min + max) / 2;
      console.log(`Диапазон ${min}-${max} преобразован в среднее: ${Math.round(average)}`);
      return Math.round(average);
    }
    
    const singleMatch = cleanValue.match(/^(\d+(?:\.\d+)?)/);
    if (singleMatch) {
      return Math.round(parseFloat(singleMatch[1]));
    }
  }
  
  console.warn('Не удалось распарсить значение калорий:', value, 'используем 200');
  return 200;
}

// Функции для работы с лимитами
async function checkDailyLimit(telegramId) {
  return new Promise((resolve, reject) => {
    const today = new Date().toISOString().split('T')[0];
    
    db.get(`SELECT dl.requests_count, u.id as user_id, u.purchased_analyses, u.unlimited_until
            FROM users u
            LEFT JOIN daily_limits dl ON u.id = dl.user_id AND dl.date = ?
            WHERE u.telegram_id = ?`, 
            [today, telegramId], (err, row) => {
      if (err) {
        reject(err);
        return;
      }
      
      const currentCount = row?.requests_count || 0;
      const userId = row?.user_id;
      const purchasedAnalyses = row?.purchased_analyses || 0;
      const unlimitedUntil = row?.unlimited_until;
      
      if (unlimitedUntil) {
        const expiryDate = new Date(unlimitedUntil);
        const now = new Date();
        
        if (expiryDate > now) {
          resolve({ 
            allowed: true, 
            remaining: 999999, 
            freeRemaining: 999999,
            purchasedRemaining: 0,
            isUnlimited: true,
            userId 
          });
          return;
        }
      }
      
      const freeRemaining = Math.max(0, 3 - currentCount);
      const totalRemaining = freeRemaining + purchasedAnalyses;
      
      if (totalRemaining <= 0) {
        resolve({ 
          allowed: false, 
          remaining: 0, 
          freeRemaining: 0,
          purchasedRemaining: purchasedAnalyses,
          isUnlimited: false,
          userId 
        });
      } else {
        resolve({ 
          allowed: true, 
          remaining: totalRemaining,
          freeRemaining: freeRemaining,
          purchasedRemaining: purchasedAnalyses,
          isUnlimited: false,
          userId 
        });
      }
    });
  });
}

async function incrementRequestCount(userId, telegramId) {
  return new Promise((resolve, reject) => {
    const today = new Date().toISOString().split('T')[0];
    
    db.get(`SELECT requests_count FROM daily_limits WHERE user_id = ? AND date = ?`, 
           [userId, today], (err, row) => {
      if (err) {
        reject(err);
        return;
      }
      
      const currentCount = row?.requests_count || 0;
      
      if (currentCount < 3) {
        db.run(`INSERT OR REPLACE INTO daily_limits (user_id, date, requests_count)
                VALUES (?, ?, ?)`,
                [userId, today, currentCount + 1], (err) => {
          if (err) reject(err);
          else resolve({ usedFree: true });
        });
      } else {
        db.run(`UPDATE users 
                SET purchased_analyses = MAX(0, purchased_analyses - 1) 
                WHERE id = ?`, [userId], (err) => {
          if (err) reject(err);
          else resolve({ usedPurchased: true });
        });
      }
    });
  });
}

// Улучшенная функция анализа еды с характером
async function analyzeFood(description) {
  console.log('🔍 Профессиональный анализ еды:', description);
  
  try {
    const prompt = `Ты - профессиональный диетолог с острым языком и чувством юмора. У тебя 20 лет опыта работы.

ТВОЙ ХАРАКТЕР:
- Ты профессионал с ЗАМЕТНОЙ иронией и легким сарказмом
- Если человек пишет грамотно - можешь быть чуть подкалывающим
- Если использует сленг (шавуха, бургос, картоха) - будь более едким, но остроумно
- ВАЖНО: Ты подкалываешь за СПОСОБ выражения или за выбор фастфуда, НО НИКОГДА за количество еды
- Ты не даешь советов похудеть и не критикуешь аппетит
- Калории считаешь ВСЕГДА правильно, независимо от тона

ПРИМЕРЫ ТВОЕГО УСИЛЕННОГО ТОНА:
"Шаурма в 9 утра" → "Смелое начало дня. Надеюсь, хоть со свежими овощами была"
"Шавуха" → "Ну раз 'шавуха', то почему бы и нет. Культурный код улицы понимаем"
"Бургер" → "Классика жанра"
"Бургос" → "Бургос... окей, записал. Калории от названия не меняются, к сожалению"
"Картоха жареная" → "Картоха значит. Изысканно"
"2 биг-мака" → "Два сразу - практично, не надо второй раз идти"

ЗАДАЧА: Сначала определи, содержит ли сообщение описание еды или напитков.

СООБЩЕНИЕ ПОЛЬЗОВАТЕЛЯ: "${description}"

ПЕРВЫЙ ШАГ - АНАЛИЗ СОДЕРЖАНИЯ:
Если в сообщении НЕТ упоминаний еды, напитков или приемов пищи, верни:
{
  "no_food_detected": true,
  "message": "Это про что угодно, только не про еду. Давай о калориях, а не о жизни",
  "tone": "заметная ирония"
}

ВТОРОЙ ШАГ - АНАЛИЗ КАЛОРИЙ (только если есть еда):

КРИТИЧЕСКИ ВАЖНО - ТОЛЬКО ТОЧНЫЕ ЧИСЛА:
- НЕ используй диапазоны (например: 200-300)
- НЕ пиши примерно или около
- ВСЕГДА выдавай ОДНО КОНКРЕТНОЕ ЧИСЛО калорий

ВАЖНЫЕ ПРИНЦИПЫ С КОНКРЕТНЫМИ ЗНАЧЕНИЯМИ:
1. "Шаурма"/"Шавуха" = 350г = 630 ккал
2. "Бургер"/"Бургос" = 250г = 540 ккал
3. "Картошка"/"Картоха" жареная = 200г = 384 ккал

КРИТИЧЕСКИ ВАЖНО ПРО ПОРЦИИ:
- ВСЕГДА указывай конкретный вес в граммах
- НИКОГДА не пиши "undefined", "неизвестно" или пустую строку
- Если точный вес неизвестен - укажи СТАНДАРТНУЮ порцию:
  * Бутерброд = 80-100г
  * Тарелка супа = 250-300мл
  * Кусок хлеба = 30-40г
  * Фрукт средний = 150-200г

ПРИМЕР JSON с усиленным характером:
{
  "items": [
    {"name": "шаурма", "portion": "350г", "calories": 630}
  ],
  "total_calories": 630,
  "confidence": "высокая",
  "reasoning": "Стандартная уличная шаурма",
  "comment": "Шавуха в 9 утра? Смело. Надеюсь, это хотя бы не с вчерашним мясом"
}

Верни JSON с едким но остроумным "comment" для сленга и фастфуда:`;

    console.log('Отправляю запрос к Claude API...');
    
    const response = await anthropic.messages.create({
      model: 'claude-3-5-haiku-20241022',
      max_tokens: 1500,
      messages: [{
        role: 'user',
        content: prompt
      }]
    });

    const content = response.content[0].text;
    console.log('Получен ответ от Claude:', content);
    
    const jsonMatch = content.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      let result = JSON.parse(jsonMatch[0]);
      console.log('JSON успешно распарсен:', result);
      console.log('Комментарий из Claude:', result.comment);
      
      if (result.items && Array.isArray(result.items)) {
        result.items = result.items.map(item => ({
          ...item,
          calories: parseCalorieValue(item.calories)
        }));
      }
      
      if (result.total_calories) {
        result.total_calories = parseCalorieValue(result.total_calories);
      }
      
      if (result.no_food_detected) {
        console.log('Claude определил: сообщение не про еду');
        return {
          no_food_detected: true,
          message: result.message || "В сообщении не найдено описание еды или напитков"
        };
      }
      
      return {
        items: result.items,
        total_calories: result.total_calories,
        confidence: result.confidence,
        reasoning: result.reasoning,
        comment: result.comment || null
      };
    } else {
      console.log('JSON не найден в ответе');
      throw new Error('Не удалось извлечь JSON из ответа');
    }
    
  } catch (error) {
    console.error('Ошибка анализа еды:', error.message);
    
    const text = description.toLowerCase().trim();
    
    const notFoodWords = ['привет', 'здравствуй', 'как дела', 'спасибо', 'пока', 'погода', 'время', 'работа', 'учеба'];
    const isNotFood = notFoodWords.some(word => text.includes(word));
    
    if (isNotFood) {
      return {
        no_food_detected: true,
        message: "Сообщение не связано с едой или напитками"
      };
    }
    
    console.log('Использую fallback из-за ошибки JSON');
    const fallbackResult = calculateFallbackCalories(description);
    return fallbackResult;
  }
}

// Улучшенный fallback расчет
function calculateFallbackCalories(description) {
  const text = description.toLowerCase();
  let items = [];
  let totalCalories = 0;
  
  console.log('Fallback анализ текста:', text);
  
  const popularDishes = {
    'борщ': { name: 'борщ', portion: '300мл', calories: 120 },
    'суп': { name: 'суп', portion: '300мл', calories: 100 },
    'шаурма': { name: 'шаурма', portion: '1шт', calories: 450 },
    'бургер': { name: 'бургер', portion: '1шт', calories: 540 },
    'пицца': { name: 'пицца', portion: '1 кусок', calories: 285 },
    'плов': { name: 'плов', portion: '200г', calories: 350 },
    'каша': { name: 'каша', portion: '200г', calories: 150 },
    'салат': { name: 'салат', portion: '150г', calories: 80 },
    'котлета': { name: 'котлета', portion: '1шт', calories: 250 },
    'омлет': { name: 'омлет', portion: '2 яйца', calories: 200 },
    'макароны': { name: 'макароны', portion: '200г', calories: 280 },
    'рис': { name: 'рис', portion: '200г', calories: 260 },
    'курица': { name: 'курица', portion: '150г', calories: 248 },
    'мясо': { name: 'мясо', portion: '150г', calories: 280 },
    'рыба': { name: 'рыба', portion: '150г', calories: 206 },
    'яйцо': { name: 'яйца', portion: '2шт', calories: 140 },
    'хлеб': { name: 'хлеб', portion: '2 куска', calories: 160 },
    'кофе': { name: 'кофе', portion: '200мл', calories: 25 },
    'чай': { name: 'чай', portion: '200мл', calories: 5 },
    'молоко': { name: 'молоко', portion: '200мл', calories: 120 },
    'яблоко': { name: 'яблоко', portion: '1шт', calories: 95 },
    'банан': { name: 'банан', portion: '1шт', calories: 105 },
    'картошка': { name: 'картофель', portion: '200г', calories: 160 },
    'картофель': { name: 'картофель', portion: '200г', calories: 160 }
  };
  
  let foundDish = false;
  for (const [dish, data] of Object.entries(popularDishes)) {
    if (text.includes(dish)) {
      items.push({ name: data.name, portion: data.portion, calories: data.calories });
      totalCalories += data.calories;
      console.log('Найдено популярное блюдо:', dish, data.calories, 'ккал');
      foundDish = true;
      break;
    }
  }
  
  if (!foundDish) {
    if (text.includes('макароны') && text.includes('сыр')) {
      items.push({ name: 'макароны с сыром', portion: '250г', calories: 350 });
      totalCalories = 350;
      foundDish = true;
      console.log('Найдено: макароны с сыром, 350 ккал');
    } else if (text.includes('рис') && text.includes('курица')) {
      items.push({ name: 'рис с курицей', portion: '300г', calories: 400 });
      totalCalories = 400;  
      foundDish = true;
      console.log('Найдено: рис с курицей, 400 ккал');
    }
  }
  
  if (items.length === 0) {
    items.push({ name: description, portion: "стандартная порция", calories: 250 });
    totalCalories = 250;
    console.log('Fallback: базовое значение 250 ккал для:', description);
  }
  
  console.log('Fallback итого найдено продуктов:', items.length, 'общие калории:', totalCalories);
  
  return {
    items,
    total_calories: totalCalories,
    confidence: "средняя (база данных)",
    reasoning: `Определено из базы популярных блюд`
  };
}

// Функции для работы с пользователями
function registerUser(telegramId, firstName, callback) {
  console.log('👤 Регистрирую пользователя:', telegramId, 'имя:', firstName);
  db.run('INSERT OR IGNORE INTO users (telegram_id, first_name) VALUES (?, ?)', [telegramId, firstName], callback);
}

function getUserName(telegramId, callback) {
  db.get('SELECT first_name FROM users WHERE telegram_id = ?', [telegramId], (err, row) => {
    if (err) {
      callback(err, null);
    } else {
      callback(null, row?.first_name || 'друг');
    }
  });
}

function updateUserGoal(telegramId, goal, callback) {
  console.log('🎯 Обновляю цель для пользователя:', telegramId, 'новая цель:', goal);
  db.run('UPDATE users SET daily_goal = ? WHERE telegram_id = ?', [goal, telegramId], callback);
}

function saveFoodEntry(telegramId, description, calories, method, callback) {
  const today = new Date().toISOString().split('T')[0];
  console.log('💾 Сохраняю запись о еде:', { telegramId, description, calories, method, date: today });
  
  db.run(`INSERT INTO food_entries (user_id, date, description, calories, analysis_method) 
          SELECT id, ?, ?, ?, ? FROM users WHERE telegram_id = ?`, 
          [today, description, calories, method, telegramId], callback);
}

function getDailyStats(telegramId, callback) {
  const today = new Date().toISOString().split('T')[0];
  console.log('📊 Получаю статистику за день для пользователя:', telegramId);
  
  db.all(`SELECT fe.*, u.daily_goal 
          FROM food_entries fe 
          JOIN users u ON fe.user_id = u.id 
          WHERE u.telegram_id = ? AND fe.date = ?`, 
          [telegramId, today], callback);
}

// ============= ОБРАБОТЧИКИ КОМАНД =============

bot.onText(/\/start/, (msg) => {
  const chatId = msg.chat.id;
  const telegramId = msg.from.id;
  const firstName = msg.from.first_name || 'друг';
  
  console.log('🎯 Команда /start от пользователя:', telegramId, 'имя:', firstName);
  
  registerUser(telegramId, firstName, (err) => {
    if (err) {
      console.error('❌ Ошибка регистрации:', err);
    }
  });
  
  const welcomeMessage = `Привет, ${firstName}!\n\n` +
    `Я твой персональный диетолог-бот!\n\n` +
    `Как это работает:\n` +
    `• Напиши что съел: "Тарелка борща"\n` +
    `• Или сфотографируй свою еду\n` +
    `• Или запиши голосовое сообщение\n` +
    `• Получи точный подсчет калорий\n` +
    `• Следи за прогрессом каждый день\n\n` +
    `У тебя есть 3 точных анализа в день\n` +
    `Лимит обновляется каждые 24 часа\n\n` +
    `Сначала выбери дневную цель калорий:`;

  const goalKeyboard = {
    reply_markup: {
      inline_keyboard: [
        [
          { text: '1700 ккал', callback_data: 'goal_1700' },
          { text: '1800 ккал', callback_data: 'goal_1800' }
        ],
        [
          { text: '1900 ккал', callback_data: 'goal_1900' },
          { text: '2000 ккал', callback_data: 'goal_2000' }
        ],
        [
          { text: '2100 ккал', callback_data: 'goal_2100' },
          { text: '2200 ккал', callback_data: 'goal_2200' }
        ]
      ]
    }
  };
  
  bot.sendMessage(chatId, welcomeMessage, goalKeyboard);
});

// Функция для установки меню бота
async function setupBotMenu() {
  try {
    await bot.setMyCommands([
      { command: 'start', description: '🚀 Начать работу с ботом' },
      { command: 'today', description: '📊 Статистика за сегодня' },
      { command: 'goal', description: '🎯 Изменить дневную цель' },
      { command: 'balance', description: '💎 Мой баланс анализов' },
      { command: 'buy', description: '🛒 Купить анализы' }
    ]);
    console.log('✅ Меню бота установлено');
  } catch (error) {
    console.error('❌ Ошибка установки меню:', error);
  }
}

// Вызываем установку меню при запуске
setupBotMenu();

bot.onText(/\/buy/, (msg) => {
  const chatId = msg.chat.id;
  const firstName = msg.from.first_name || 'друг';
  
  const buyMessage = `${firstName}, хочешь больше анализов?\n\n` +
    `Доступные пакеты:\n` +
    `🔹 +10 анализов - 50 Stars ⭐\n` +
    `🔹 +25 анализов - 100 Stars ⭐\n` +
    `🔹 +50 анализов - 150 Stars ⭐\n` +
    `💎 Безлимит на месяц - 200 Stars ⭐\n\n` +
    `Выбери пакет:`;
  
  const buyKeyboard = {
    reply_markup: {
      inline_keyboard: [
        [{ text: '🔹 +10 анализов (50 ⭐)', callback_data: 'buy_10' }],
        [{ text: '🔹 +25 анализов (100 ⭐)', callback_data: 'buy_25' }],
        [{ text: '🔹 +50 анализов (150 ⭐)', callback_data: 'buy_50' }],
        [{ text: '💎 Безлимит на месяц (200 ⭐)', callback_data: 'buy_unlimited' }]
      ]
    }
  };
  
  bot.sendMessage(chatId, buyMessage, buyKeyboard);
});

bot.onText(/\/balance/, async (msg) => {
  const chatId = msg.chat.id;
  const telegramId = msg.from.id;
  
  try {
    const limitInfo = await checkDailyLimit(telegramId);
    const firstName = msg.from.first_name || 'друг';
    
    db.get('SELECT purchased_analyses, unlimited_until FROM users WHERE telegram_id = ?', [telegramId], (err, row) => {
      const purchased = row?.purchased_analyses || 0;
      const unlimitedUntil = row?.unlimited_until;
      
      let message = `${firstName}, твой баланс:\n\n`;
      
      if (unlimitedUntil) {
        const expiryDate = new Date(unlimitedUntil);
        const now = new Date();
        
        if (expiryDate > now) {
          const daysLeft = Math.ceil((expiryDate - now) / (1000 * 60 * 60 * 24));
          message += `💎 Безлимитная подписка активна\n`;
          message += `⏰ Осталось дней: ${daysLeft}\n\n`;
        } else {
          message += `📊 Бесплатных анализов сегодня: ${limitInfo.freeRemaining}/3\n`;
          message += `💎 Купленных анализов: ${purchased}\n\n`;
        }
      } else {
        message += `📊 Бесплатных анализов сегодня: ${limitInfo.freeRemaining}/3\n`;
        message += `💎 Купленных анализов: ${purchased}\n\n`;
      }
      
      if (!unlimitedUntil && purchased === 0 && limitInfo.freeRemaining === 0) {
        message += `Хочешь больше анализов? Используй /buy`;
      }
      
      bot.sendMessage(chatId, message);
    });
  } catch (error) {
    console.error('Ошибка получения баланса:', error);
    bot.sendMessage(chatId, 'Ошибка при получении баланса');
  }
});

bot.onText(/\/today/, (msg) => {
  const chatId = msg.chat.id;
  const telegramId = msg.from.id;
  
  console.log('📈 Команда /today от пользователя:', telegramId);
  
  getDailyStats(telegramId, (err, rows) => {
    if (err) {
      console.error('❌ Ошибка получения статистики:', err);
      bot.sendMessage(chatId, 'Произошла ошибка при получении статистики');
      return;
    }
    
    getUserName(telegramId, (nameErr, firstName) => {
      const name = nameErr ? 'друг' : firstName;
      
      if (rows.length === 0) {
        bot.sendMessage(chatId, `${name}, сегодня записей о еде пока нет 🤷‍♂️\n\nПросто напиши что съел!`);
        return;
      }
      
      const totalCalories = rows.reduce((sum, row) => sum + row.calories, 0);
      const dailyGoal = rows[0].daily_goal;
      const remaining = dailyGoal - totalCalories;
      const percentage = Math.round((totalCalories / dailyGoal) * 100);
      
      let message = `📊 ${name}, твоя статистика за сегодня:\n\n`;
      message += `🔥 Съедено: **${totalCalories} ккал**\n`;
      message += `🎯 Цель: ${dailyGoal} ккал\n`;
      message += `📈 Прогресс: ${percentage}%\n`;
      message += `${remaining > 0 ? '✅' : '❌'} Осталось: ${remaining} ккал\n\n`;
      message += `📝 **Записи:**\n`;
      
      rows.forEach((row, index) => {
        const method = row.analysis_method === 'claude' ? '🤖' : '⚡';
        message += `${index + 1}. ${row.description} - ${row.calories} ккал ${method}\n`;
      });
      
      bot.sendMessage(chatId, message, { parse_mode: 'Markdown' });
    });
  });
});

bot.onText(/\/goal/, (msg) => {
  const chatId = msg.chat.id;
  const firstName = msg.from.first_name || 'друг';
  
  const goalMessage = `${firstName}, выбери новую дневную цель калорий:`;
  
  const goalKeyboard = {
    reply_markup: {
      inline_keyboard: [
        [
          { text: '1700 ккал', callback_data: 'goal_1700' },
          { text: '1800 ккал', callback_data: 'goal_1800' }
        ],
        [
          { text: '1900 ккал', callback_data: 'goal_1900' },
          { text: '2000 ккал', callback_data: 'goal_2000' }
        ],
        [
          { text: '2100 ккал', callback_data: 'goal_2100' },
          { text: '2200 ккал', callback_data: 'goal_2200' }
        ]
      ]
    }
  };
  
  bot.sendMessage(chatId, goalMessage, goalKeyboard);
});

// ============= ОПТИМИЗИРОВАННЫЙ ОБРАБОТЧИК CALLBACK (БЕЗ ДУБЛИРОВАНИЯ) =============
bot.on('callback_query', async (callbackQuery) => {
  const msg = callbackQuery.message;
  const chatId = msg.chat.id;
  const telegramId = callbackQuery.from.id;
  const data = callbackQuery.data;
  
  // Обработка показа меню покупок
  if (data === 'show_buy_menu') {
    const firstName = callbackQuery.from.first_name || 'друг';
    
    const buyMessage = `${firstName}, хочешь больше анализов?\n\n` +
      `Доступные пакеты:\n` +
      `🔹 +10 анализов - 50 Stars ⭐\n` +
      `🔹 +25 анализов - 100 Stars ⭐\n` +
      `🔹 +50 анализов - 150 Stars ⭐\n` +
      `💎 Безлимит на месяц - 200 Stars ⭐\n\n` +
      `Выбери пакет:`;
    
    const buyKeyboard = {
      reply_markup: {
        inline_keyboard: [
          [{ text: '🔹 +10 анализов (50 ⭐)', callback_data: 'buy_10' }],
          [{ text: '🔹 +25 анализов (100 ⭐)', callback_data: 'buy_25' }],
          [{ text: '🔹 +50 анализов (150 ⭐)', callback_data: 'buy_50' }],
          [{ text: '💎 Безлимит на месяц (200 ⭐)', callback_data: 'buy_unlimited' }]
        ]
      }
    };
    
    bot.editMessageText(buyMessage, {
      chat_id: chatId,
      message_id: msg.message_id,
      reply_markup: buyKeyboard.reply_markup
    });
    
    bot.answerCallbackQuery(callbackQuery.id);
    return;
  }
  
  // Обработка показа статистики
  if (data === 'show_today_stats') {
    bot.answerCallbackQuery(callbackQuery.id);
    
    getDailyStats(telegramId, (err, rows) => {
      if (err) {
        console.error('❌ Ошибка получения статистики:', err);
        bot.sendMessage(chatId, 'Произошла ошибка при получении статистики');
        return;
      }
      
      getUserName(telegramId, (nameErr, firstName) => {
        const name = nameErr ? 'друг' : firstName;
        
        if (rows.length === 0) {
          bot.sendMessage(chatId, `${name}, сегодня записей о еде пока нет 🤷‍♂️\n\nПросто напиши что съел!`);
          return;
        }
        
        const totalCalories = rows.reduce((sum, row) => sum + row.calories, 0);
        const dailyGoal = rows[0].daily_goal;
        const remaining = dailyGoal - totalCalories;
        const percentage = Math.round((totalCalories / dailyGoal) * 100);
        
        let message = `📊 ${name}, твоя статистика за сегодня:\n\n`;
        message += `🔥 Съедено: **${totalCalories} ккал**\n`;
        message += `🎯 Цель: ${dailyGoal} ккал\n`;
        message += `📈 Прогресс: ${percentage}%\n`;
        message += `${remaining > 0 ? '✅' : '❌'} Осталось: ${remaining} ккал\n\n`;
        message += `📝 **Записи:**\n`;
        
        rows.forEach((row, index) => {
          const method = row.analysis_method === 'claude' ? '🤖' : '⚡';
          message += `${index + 1}. ${row.description} - ${row.calories} ккал ${method}\n`;
        });
        
        bot.sendMessage(chatId, message, { parse_mode: 'Markdown' });
      });
    });
    return;
  }
  
  // Обработка выбора цели
  if (data.startsWith('goal_')) {
    const goal = parseInt(data.replace('goal_', ''));
    
    updateUserGoal(telegramId, goal, (err) => {
      if (err) {
        console.error('Ошибка установки цели:', err);
        bot.answerCallbackQuery(callbackQuery.id, 'Ошибка при установке цели');
        return;
      }
      
      db.run('UPDATE users SET goal_set = TRUE WHERE telegram_id = ?', [telegramId]);
      
      const firstName = callbackQuery.from.first_name || 'друг';
      const successMessage = `Отлично, ${firstName}!\n\n` +
        `Дневная цель: ${goal} ккал\n\n` +
        `Теперь можешь начать:\n` +
        `• Напиши что съел текстом\n` +
        `• Сфотографируй свою еду\n` +
        `• Или отправь голосовое сообщение\n` +
        `• Например: "Овсянка с бананом"\n\n` +
        `У тебя есть 3 точных анализа в день\n` +
        `Лимит обновляется каждые 24 часа\n\n` +
        `Готов к работе! Напиши, сфотографируй или наговори что съел`;
      
      bot.editMessageText(successMessage, {
        chat_id: chatId,
        message_id: msg.message_id
      });
      
      bot.answerCallbackQuery(callbackQuery.id, { 
        text: `Цель ${goal} ккал установлена!`,
        show_alert: false 
      });
    });
    return;
  }
  
  // Обработка покупки анализов
  if (data.startsWith('buy_')) {
    const packages = {
      'buy_10': { analyses: 10, stars: 50, type: 'analyses' },
      'buy_25': { analyses: 25, stars: 100, type: 'analyses' },
      'buy_50': { analyses: 50, stars: 150, type: 'analyses' },
      'buy_unlimited': { analyses: 0, stars: 200, type: 'unlimited' }
    };
    
    const selectedPackage = packages[data];
    if (!selectedPackage) return;
    
    try {
      let title, description, payload;
      
      if (selectedPackage.type === 'unlimited') {
        title = 'Безлимит на месяц';
        description = 'Неограниченные анализы еды в течение 30 дней';
        payload = `unlimited_30_${telegramId}`;
      } else {
        title = `+${selectedPackage.analyses} анализов`;
        description = `Получи ${selectedPackage.analyses} дополнительных анализов еды`;
        payload = `analyses_${selectedPackage.analyses}_${telegramId}`;
      }
      
      const currency = 'XTR';
      const prices = [{ label: title, amount: selectedPackage.stars }];
      
      await bot.sendInvoice(
        chatId,
        title,
        description,
        payload,
        '',
        currency,
        prices,
        {
          reply_markup: {
            inline_keyboard: [[
              { text: `Оплатить ${selectedPackage.stars} ⭐`, pay: true }
            ]]
          }
        }
      );
      
      bot.answerCallbackQuery(callbackQuery.id);
      
    } catch (error) {
      console.error('Ошибка создания инвойса:', error);
      bot.answerCallbackQuery(callbackQuery.id, 'Ошибка при создании платежа');
    }
  }
});

// Обработка pre_checkout запроса
bot.on('pre_checkout_query', (query) => {
  console.log('Pre-checkout query:', query);
  bot.answerPreCheckoutQuery(query.id, true);
});

// Обработка успешного платежа
bot.on('successful_payment', (msg) => {
  const telegramId = msg.from.id;
  const payload = msg.successful_payment.invoice_payload;
  
  console.log('Успешный платеж:', payload);
  
  if (payload.startsWith('unlimited_')) {
    const expiryDate = new Date();
    expiryDate.setDate(expiryDate.getDate() + 30);
    const expiryDateString = expiryDate.toISOString().split('T')[0];
    
    db.run(`UPDATE users 
            SET unlimited_until = ? 
            WHERE telegram_id = ?`, 
            [expiryDateString, telegramId], (err) => {
      if (err) {
        console.error('Ошибка активации безлимита:', err);
        bot.sendMessage(msg.chat.id, 'Ошибка при активации подписки. Обратитесь в поддержку.');
        return;
      }
      
      const firstName = msg.from.first_name || 'друг';
      bot.sendMessage(
        msg.chat.id, 
        `${firstName}, спасибо за покупку!\n\n` +
        `💎 Безлимитная подписка активирована на 30 дней\n` +
        `⏰ Действует до: ${expiryDate.toLocaleDateString('ru-RU')}\n\n` +
        `Теперь у тебя неограниченные анализы!\n` +
        `Проверить статус: /balance`
      );
    });
  } else {
    const match = payload.match(/analyses_(\d+)_/);
    if (match) {
      const analysesCount = parseInt(match[1]);
      
      db.run(`UPDATE users 
              SET purchased_analyses = COALESCE(purchased_analyses, 0) + ? 
              WHERE telegram_id = ?`, 
              [analysesCount, telegramId], (err) => {
        if (err) {
          console.error('Ошибка обновления анализов:', err);
          bot.sendMessage(msg.chat.id, 'Ошибка при добавлении анализов. Обратитесь в поддержку.');
          return;
        }
        
        const firstName = msg.from.first_name || 'друг';
        bot.sendMessage(
          msg.chat.id, 
          `${firstName}, спасибо за покупку!\n\n` +
          `✅ Тебе добавлено ${analysesCount} анализов\n\n` +
          `Проверить баланс: /balance`
        );
      });
    }
  }
});

// ============= ОБРАБОТЧИКИ МЕДИА =============

// Обработка голосовых сообщений
bot.on('voice', async (msg) => {
  const chatId = msg.chat.id;
  const telegramId = msg.from.id;
  
  console.log('🎤 Получено голосовое сообщение от пользователя:', telegramId);
  console.log('🎤 Длительность:', msg.voice.duration, 'сек, размер:', msg.voice.file_size, 'байт');
  
  db.get('SELECT goal_set FROM users WHERE telegram_id = ?', [telegramId], async (err, row) => {
    if (err || !row?.goal_set) {
      bot.sendMessage(chatId, 
        '🎯 Сначала установи дневную цель калорий командой /start или /goal'
      );
      return;
    }
    
    const maxDuration = 60;
    if (msg.voice.duration > maxDuration) {
      console.log('Голосовое сообщение слишком длинное:', msg.voice.duration, 'сек');
      
      const name = await getUserNameAsync(telegramId);
      
      bot.sendMessage(chatId, 
        `${name}, голосовое сообщение слишком длинное (${msg.voice.duration} сек)\n\n` +
        `Максимум: ${maxDuration} секунд\n\n` +
        `Запиши кратко что съел, например:\n` +
        `"Съел тарелку супа с хлебом"\n` +
        `"Выпил кофе с печеньем"`
      );
      return;
    }
    
    const processingMsg = await bot.sendMessage(chatId, '🎤 Расшифровываю голосовое сообщение...');
    
    try {
      const audioBuffer = await downloadTelegramFile(msg.voice.file_id);
      const transcribedText = await transcribeAudioWithFallback(audioBuffer, 'voice.ogg');
      
      if (!transcribedText || transcribedText.trim().length < 2) {
        console.log('⚠️ Расшифровка слишком короткая:', transcribedText);
        bot.editMessageText(`❌ Расшифровка слишком короткая: "${transcribedText}"\n\nПопробуй:\n• Говорить четче\n• Записать подольше\n• Написать текстом`, {
          chat_id: chatId,
          message_id: processingMsg.message_id
        });
        return;
      }
      
      console.log('✅ Расшифровка полностью готова, длина:', transcribedText.trim().length, 'символов');
      
      bot.deleteMessage(chatId, processingMsg.message_id);
      await bot.sendMessage(chatId, `🎤 **Расшифровка:** "${transcribedText.trim()}"`, { parse_mode: 'Markdown' });
      await processFoodFromVoice(transcribedText.trim(), chatId, telegramId);
      
    } catch (error) {
      console.error('❌ Полная ошибка обработки голосового:', error);
      
      let userMessage = '❌ Не удалось обработать голосовое сообщение.\n\n💡 **Попробуй:**\n';
      
      if (error.message.includes('расшифровать')) {
        userMessage += '• Говорить четче и громче\n• Уменьшить фоновый шум\n• Говорить медленнее';
      } else if (error.message.includes('скачать')) {
        userMessage += '• Записать сообщение заново\n• Проверить интернет соединение';
      } else {
        userMessage += '• Записать четче\n• Написать текстом что съел';
      }
      
      userMessage += `\n\n🔧 ${error.message}`;
      
      bot.editMessageText(userMessage, {
        chat_id: chatId,
        message_id: processingMsg.message_id
      });
    }
  });
});

// Обработка фото еды
bot.on('photo', async (msg) => {
  const chatId = msg.chat.id;
  const telegramId = msg.from.id;
  
  console.log('📸 Получено фото от пользователя:', telegramId);
  
  db.get('SELECT goal_set FROM users WHERE telegram_id = ?', [telegramId], async (err, row) => {
    if (err || !row?.goal_set) {
      bot.sendMessage(chatId, 
        'Сначала установи дневную цель калорий командой /start или /goal'
      );
      return;
    }
    
    const processingMsg = await bot.sendMessage(chatId, 'Анализирую фото еды...');
    
    try {
      const photos = msg.photo;
      const bestPhoto = photos[photos.length - 1];
      
      const maxSize = 5 * 1024 * 1024;
      if (bestPhoto.file_size && bestPhoto.file_size > maxSize) {
        console.log('Фото слишком большое:', bestPhoto.file_size, 'байт');
        
        const name = await getUserNameAsync(telegramId);
        
        bot.editMessageText(
          `${name}, фото слишком большое (${(bestPhoto.file_size/1024/1024).toFixed(1)} МБ)\n\n` +
          `Максимум: 5 МБ\n\n` +
          `Сожми фото или сделай новое`, {
            chat_id: chatId,
            message_id: processingMsg.message_id
          });
        return;
      }
      
      const photoBuffer = await downloadTelegramFile(bestPhoto.file_id);
      const base64Image = photoBuffer.toString('base64');
      
      if (base64Image.length > 20 * 1024 * 1024) {
        console.log('Base64 фото слишком большое для Claude API');
        
        const name = await getUserNameAsync(telegramId);
        
        bot.editMessageText(
          `${name}, фото слишком детализированное для анализа\n\n` +
          `Попробуй:\n` +
          `• Сделать фото с меньшим разрешением\n` +
          `• Сфотографировать только тарелку\n` +
          `• Написать текстом что съел`, {
            chat_id: chatId,
            message_id: processingMsg.message_id
          });
        return;
      }
      
      await processPhotoFood(base64Image, chatId, telegramId, processingMsg.message_id);
      
    } catch (error) {
      console.error('Ошибка обработки фото:', error);
      
      bot.editMessageText(
        'Не удалось обработать фото\n\n' +
        'Попробуй:\n' +
        '• Сделать фото четче\n' +
        '• Убедиться что на фото видна еда\n' +
        '• Написать текстом что съел', {
          chat_id: chatId,
          message_id: processingMsg.message_id
        });
    }
  });
});

// Обработка аудио файлов
bot.on('audio', async (msg) => {
  const chatId = msg.chat.id;
  bot.sendMessage(chatId, 
    '🎵 Получен аудио файл, но для анализа еды используй голосовые сообщения 🎤\n\n' +
    '💡 Нажми и удерживай кнопку микрофона для записи голосового сообщения.'
  );
});

// ============= ФУНКЦИИ ОБРАБОТКИ =============

// Функция для анализа фото еды через Claude Vision
async function processPhotoFood(base64Image, chatId, telegramId, processingMessageId) {
  console.log('📸 Анализирую фото еды через Claude Vision');
  
  try {
    const limitInfo = await checkDailyLimit(telegramId);
    
    if (limitInfo.allowed) {
      console.log('Отправляю фото Claude для анализа');
      
      const response = await anthropic.messages.create({
        model: 'claude-3-5-haiku-20241022',
        max_tokens: 1500,
        messages: [{
          role: 'user',
          content: [
            {
              type: 'text',
              text: `Ты - профессиональный диетолог с легкой иронией. Анализируешь фото еды.

ВАЖНО ПРО ФОТО: 
- По фото НЕВОЗМОЖНО определить калории точно
- Ты можешь только ПРИМЕРНО оценить
- ОБЯЗАТЕЛЬНО добавь в reasoning что это приблизительная оценка по фото
- Посоветуй в следующий раз написать текстом для точности

ТВОЙ ХАРАКТЕР (как и в текстовых ответах):
- Профессионал с легкой иронией
- Если видишь фастфуд - можешь мягко прокомментировать
- Но ВСЕГДА даешь корректную оценку калорий

ЗАДАЧА: Определи, есть ли на фото еда.

ПЕРВЫЙ ШАГ - ЧТО НА ФОТО:
Если на фото НЕТ еды или напитков, верни:
{
  "no_food_detected": true,
  "message": "На фото [что видишь], но это явно не еда",
  "comment": "В следующий раз фоткай тарелку, а не [что там]"
}

ВТОРОЙ ШАГ - ПРИМЕРНАЯ ОЦЕНКА (если есть еда):
КРИТИЧЕСКИ ВАЖНО:
- НЕ используй диапазоны - только ОДНО число
- Округляй до целых
- В reasoning ОБЯЗАТЕЛЬНО укажи что оценка приблизительная

Верни JSON:
{
  "items": [
    {"name": "продукт", "portion": "примерно Хг", "calories": число}
  ],
  "total_calories": число,
  "confidence": "низкая - оценка по фото",
  "reasoning": "По фото сложно определить точно, примерная оценка. Для точности лучше написать текстом что съел",
  "comment": "[твой легкий ироничный комментарий если уместно]"
}`
            },
            {
              type: 'image',
              source: {
                type: 'base64',
                media_type: 'image/jpeg',
                data: base64Image
              }
            }
          ]
        }]
      });

      const content = response.content[0].text;
      console.log('Получен ответ от Claude Vision:', content);
      
      const jsonMatch = content.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        let analysis = JSON.parse(jsonMatch[0]);
        
        if (analysis.items && Array.isArray(analysis.items)) {
          analysis.items = analysis.items.map(item => ({
            ...item,
            calories: parseCalorieValue(item.calories)
          }));
        }
        
        if (analysis.total_calories) {
          analysis.total_calories = parseCalorieValue(analysis.total_calories);
        }
        
        bot.deleteMessage(chatId, processingMessageId);
        await incrementRequestCount(limitInfo.userId, telegramId);
        
        if (analysis.no_food_detected) {
          console.log('Claude определил: на фото нет еды, но лимит потрачен');
          
          const name = await getUserNameAsync(telegramId);
          const newLimit = await checkDailyLimit(telegramId);
          
          let response = `${name}, ${analysis.message || 'на фото не найдено еды'}\n\n`;
          
          if (analysis.comment) {
            response += `💬 ${analysis.comment}\n\n`;
          }
          
          response += `Ты потратил один анализ зря! В следующий раз фотографируй еду:\n` +
            `• Тарелку с едой\n` +
            `• Напитки\n` +
            `• Снеки и десерты\n\n` +
            `Осталось анализов: ${newLimit.remaining}/3`;
          
          // Если анализы закончились - предлагаем купить
          if (newLimit.remaining === 0) {
            bot.sendMessage(chatId, response, {
              reply_markup: {
                inline_keyboard: [
                  [{ text: '🛒 Купить анализы', callback_data: 'show_buy_menu' }],
                  [{ text: '📊 Посмотреть статистику', callback_data: 'show_today_stats' }]
                ]
              }
            });
          } else {
            bot.sendMessage(chatId, response);
          }
          return;
        }
        
        saveFoodEntry(telegramId, `📸 Фото еды`, analysis.total_calories, 'claude', (err) => {
          if (err) {
            console.error('Ошибка сохранения фото:', err);
          } else {
            console.log('Фото анализ сохранен в базу');
          }
        });
        
        const name = await getUserNameAsync(telegramId);
        let response = '';
        
        if (analysis.comment) {
          response += `💬 <b>${analysis.comment}</b>\n\n`;
        }
        
        if (analysis.items && analysis.items.length > 0) {
          response += `📸 Что вижу на фото:\n`;
          analysis.items.forEach(item => {
            response += `• ${item.name} (${item.portion}) - ${item.calories} ккал\n`;
          });
          response += `\n`;
        }
        
        response += `${name}, по фото примерно: <b>${analysis.total_calories} ккал</b>\n\n`;
        response += `⚠️ ${analysis.reasoning}\n\n`;
        
        const newLimit = await checkDailyLimit(telegramId);
        if (newLimit.remaining > 0) {
          response += `Осталось анализов: ${newLimit.remaining}\n\n`;
          response += `💡 Для точного подсчета лучше пиши текстом\n`;
          response += `📊 Посмотреть статистику: /today`;
          bot.sendMessage(chatId, response, { parse_mode: 'HTML' });
        } else {
          response += `Это был твой последний анализ на сегодня\n\n`;
          response += `💡 Для точного подсчета лучше пиши текстом\n`;
          response += `Хочешь больше анализов?`;
          bot.sendMessage(chatId, response, { 
            parse_mode: 'HTML',
            reply_markup: {
              inline_keyboard: [
                [{ text: '🛒 Купить анализы', callback_data: 'show_buy_menu' }],
                [{ text: '📊 Посмотреть статистику', callback_data: 'show_today_stats' }]
              ]
            }
          });
        }
        
      } else {
        throw new Error('Не удалось распарсить ответ Claude');
      }
      
    } else {
      bot.deleteMessage(chatId, processingMessageId);
      
      const name = await getUserNameAsync(telegramId);
      
      bot.sendMessage(chatId, 
        `${name}, твои анализы на сегодня закончились\n\n` +
        `Фото получено, но для анализа приходи завтра!\n\n` +
        `В 00:00 будут доступны 3 новых анализа\n\n` +
        `💡 Или купи анализы прямо сейчас:`,
        {
          reply_markup: {
            inline_keyboard: [
              [{ text: '🛒 Купить анализы', callback_data: 'show_buy_menu' }],
              [{ text: '📊 Посмотреть статистику', callback_data: 'show_today_stats' }]
            ]
          }
        }
      );
    }
    
  } catch (error) {
    console.error('Ошибка анализа фото еды:', error);
    bot.editMessageText('Произошла ошибка при анализе фото. Попробуй еще раз.', {
      chat_id: chatId,
      message_id: processingMessageId
    });
  }
}

// Функция для обработки голосового описания еды
async function processFoodFromVoice(text, chatId, telegramId) {
  console.log('Начинаю обработку расшифровки как еды...');
  console.log('Входящий текст:', `"${text}"`);
  
  if (!text || typeof text !== 'string') {
    throw new Error('Некорректный тип данных для анализа');
  }
  
  const cleanText = text.trim();
  if (cleanText.length === 0 || cleanText === 'undefined') {
    throw new Error('Пустой или некорректный текст для анализа');
  }
  
  console.log('Текст валиден, отправляю Claude');
  
  try {
    const limitInfo = await checkDailyLimit(telegramId);
    
    if (limitInfo.allowed) {
      const processingMsg = await bot.sendMessage(chatId, 'Анализирую голосовое сообщение...');
      
      console.log('Вызываю Claude с текстом:', cleanText);
      const analysis = await analyzeFood(cleanText);
      
      bot.deleteMessage(chatId, processingMsg.message_id);
      
      if (analysis.no_food_detected) {
        console.log('Claude определил: голосовое не про еду, но лимит УЖЕ потрачен');
        
        await incrementRequestCount(limitInfo.userId, telegramId);
        
        const name = await getUserNameAsync(telegramId);
        const newLimit = await checkDailyLimit(telegramId);
        
        bot.sendMessage(chatId, 
          `${name}, по голосовому сообщению:\n"${cleanText}"\n\n` +
          `${analysis.message || 'Не найдено описание еды'}\n\n` +
          `Ты потратил один из своих дневных анализов зря! В следующий раз записывай голосовые про еду:\n` +
          `• "Съел тарелку супа"\n` +
          `• "Выпил кофе с печеньем"\n` +
          `• "Яблоко и банан"\n\n` +
          `Осталось анализов: ${newLimit.remaining}/3`
        );
        return;
      }
      
      await incrementRequestCount(limitInfo.userId, telegramId);
      
      saveFoodEntry(telegramId, `${cleanText}`, analysis.total_calories, 'claude', (err) => {
        if (err) {
          console.error('Ошибка сохранения голосовой записи:', err);
        } else {
          console.log('Голосовая запись сохранена в базу');
        }
      });
      
      const name = await getUserNameAsync(telegramId);
      let response = `${name}, по твоему голосовому сообщению:\n\n`;
      
      if (analysis.comment) {
        response += `💬 ${analysis.comment}\n\n`;
      }
      
      response += `Этот прием пищи содержал ${analysis.total_calories} ккал\n\n`;
      
      if (analysis.items.length > 1) {
        response += `Вот детализация:\n`;
        analysis.items.forEach(item => {
          response += `• ${item.name} (${item.portion}) - ${item.calories} ккал\n`;
        });
        response += `\n`;
      }
      
      const newLimit = await checkDailyLimit(telegramId);
      if (newLimit.remaining > 0) {
        response += `Осталось анализов: ${newLimit.remaining}\n\n`;
        response += `Посмотреть статистику: /today`;
        bot.sendMessage(chatId, response);
      } else {
        response += `Это был твой последний анализ на сегодня\n\n`;
        response += `💡 Хочешь больше анализов?`;
        bot.sendMessage(chatId, response, {
          reply_markup: {
            inline_keyboard: [
              [{ text: '🛒 Купить анализы', callback_data: 'show_buy_menu' }],
              [{ text: '📊 Посмотреть статистику', callback_data: 'show_today_stats' }]
            ]
          }
        });
      }
      
    } else {
      const name = await getUserNameAsync(telegramId);
      
      bot.sendMessage(chatId, 
        `${name}, твои точные анализы на сегодня закончились\n\n` +
        `Голосовое сообщение записано, но для анализа приходи завтра!\n\n` +
        `В 00:00 будут доступны 3 новых анализа\n\n` +
        `💡 Или купи анализы прямо сейчас:`,
        {
          reply_markup: {
            inline_keyboard: [
              [{ text: '🛒 Купить анализы', callback_data: 'show_buy_menu' }],
              [{ text: '📊 Посмотреть статистику', callback_data: 'show_today_stats' }]
            ]
          }
        }
      );
      return;
    }
    
  } catch (error) {
    console.error('Ошибка обработки голосового описания еды:', error);
    bot.sendMessage(chatId, 'Произошла ошибка при анализе голосового сообщения. Попробуй еще раз.');
  }
}

// Обработка обычных текстовых сообщений
bot.on('message', async (msg) => {
  const chatId = msg.chat.id;
  const text = msg.text;
  const telegramId = msg.from.id;
  
  if (text && text.startsWith('/')) return;
  if (msg.voice || msg.audio || msg.photo || msg.video || msg.video_note || msg.document) return;
  
  if (!text || typeof text !== 'string' || text.trim().length === 0) {
    console.log('Пропускаю сообщение без текста или с пустым текстом');
    return;
  }
  
  const maxLength = 500;
  if (text.length > maxLength) {
    console.log('Сообщение слишком длинное:', text.length, 'символов');
    
    const name = await getUserNameAsync(telegramId);
    
    bot.sendMessage(chatId, 
      `${name}, сообщение слишком длинное (${text.length} символов)\n\n` +
      `Максимум: ${maxLength} символов\n\n` +
      `Опиши еду кратко, например:\n` +
      `"Тарелка борща с хлебом"\n` +
      `"Кофе с печеньем"\n` +
      `"Салат цезарь"`
    );
    return;
  }
  
  console.log('Обрабатываю ТЕКСТОВОЕ сообщение:', text, 'от пользователя:', telegramId);
  
  db.get('SELECT goal_set FROM users WHERE telegram_id = ?', [telegramId], (err, row) => {
    if (err || !row?.goal_set) {
      bot.sendMessage(chatId, 
        '🎯 Сначала установи дневную цель калорий командой /start или /goal'
      );
      return;
    }
    
    processMessage();
  });
  
  async function processMessage() {
    try {
      const limitInfo = await checkDailyLimit(telegramId);
      
      let analysis;
      let method;
      
      if (limitInfo.allowed) {
        const processingMsg = await bot.sendMessage(chatId, 'Анализирую сообщение...');
        
        console.log('Анализирую текст через Claude:', text);
        analysis = await analyzeFood(text);
        method = 'claude';
        
        bot.deleteMessage(chatId, processingMsg.message_id);
        
        if (analysis.no_food_detected) {
          console.log('Claude определил: не про еду, но лимит УЖЕ потрачен');
          
          await incrementRequestCount(limitInfo.userId, telegramId);
          
          const name = await getUserNameAsync(telegramId);
          const newLimit = await checkDailyLimit(telegramId);
          
          let response = `${name}, ${analysis.message || 'в сообщении не найдено описание еды'}\n\n` +
            `Ты потратил один из своих дневных анализов зря! В следующий раз пиши про еду:\n` +
            `• "Тарелка супа с хлебом"\n` +
            `• "Кофе с печеньем"\n` +
            `• "Яблоко и банан"\n\n` +
            `Осталось анализов: ${newLimit.remaining}/3`;
          
          // Если анализы закончились - предлагаем купить
          if (newLimit.remaining === 0) {
            bot.sendMessage(chatId, response, {
              reply_markup: {
                inline_keyboard: [
                  [{ text: '🛒 Купить анализы', callback_data: 'show_buy_menu' }],
                  [{ text: '📊 Посмотреть статистику', callback_data: 'show_today_stats' }]
                ]
              }
            });
          } else {
            bot.sendMessage(chatId, response);
          }
          return;
        }
        
        await incrementRequestCount(limitInfo.userId, telegramId);
        
      } else {
        const name = await getUserNameAsync(telegramId);
        
        bot.sendMessage(chatId, 
          `${name}, твои точные анализы на сегодня закончились\n\n` +
          `Завтра в 00:00 будут доступны 3 новых точных анализа!\n\n` +
          `Посмотреть статистику: /today`
        );
        return;
      }
      
      saveFoodEntry(telegramId, text, analysis.total_calories, method, (err) => {
        if (err) {
          console.error('Ошибка сохранения:', err);
        } else {
          console.log('Запись сохранена в базу');
        }
      });
      
      const name = await getUserNameAsync(telegramId);
      let response = '';
      
      if (analysis.comment && analysis.comment.trim().length > 0) {
        response += `💬 <b>${analysis.comment}</b>\n\n`;
      }
      
      response += `${name}, этот прием пищи содержал <b>${analysis.total_calories} ккал</b>\n\n`;
      
      if (analysis.items && analysis.items.length > 1) {
        response += `Вот что было:\n`;
        analysis.items.forEach(item => {
          response += `• ${item.name} (${item.portion}) - ${item.calories} ккал\n`;
        });
        response += `\n`;
      }
      
      const newLimit = await checkDailyLimit(telegramId);
      if (newLimit.remaining > 0) {
        response += `Осталось анализов: ${newLimit.remaining}\n\n`;
        response += `Посмотреть статистику: /today`;
        bot.sendMessage(chatId, response, { parse_mode: 'HTML' });
      } else {
        response += `Это был твой последний анализ на сегодня\n\n`;
        response += `💡 Хочешь больше анализов?`;
        bot.sendMessage(chatId, response, { 
          parse_mode: 'HTML',
          reply_markup: {
            inline_keyboard: [
              [{ text: '🛒 Купить анализы', callback_data: 'show_buy_menu' }],
              [{ text: '📊 Посмотреть статистику', callback_data: 'show_today_stats' }]
            ]
          }
        });
      }
      
    } catch (error) {
      console.error('Ошибка обработки сообщения:', error);
      bot.sendMessage(chatId, 'Произошла ошибка при анализе. Попробуй еще раз.');
    }
  }
});

// ============= НАПОМИНАНИЯ =============

// Напоминания каждый день в 21:00
cron.schedule('0 21 * * *', () => {
  console.log('⏰ Отправляем напоминания...');
  const today = new Date().toISOString().split('T')[0];
  
  db.all(`SELECT DISTINCT u.telegram_id 
          FROM users u 
          LEFT JOIN food_entries fe ON u.id = fe.user_id AND fe.date = ?
          WHERE fe.id IS NULL`, [today], (err, users) => {
    if (err) {
      console.error('❌ Ошибка получения пользователей для напоминаний:', err);
      return;
    }
    
    console.log('📤 Отправляю напоминания', users.length, 'пользователям');
    
    users.forEach(user => {
      bot.sendMessage(user.telegram_id, 
        '🍽️ Не забудь записать что ел сегодня!\n\n' +
        'Просто напиши мне описание еды, и я подсчитаю калории.'
      );
    });
  });
});

console.log('🤖 Продвинутый бот запущен и готов к работе!');