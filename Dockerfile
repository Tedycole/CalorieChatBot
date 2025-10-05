FROM node:18-alpine

WORKDIR /app

# Копируем package files
COPY package*.json ./

# Устанавливаем зависимости
RUN npm ci --only=production

# Копируем код
COPY . .

# Создаем директорию для БД
RUN mkdir -p /app/data

CMD ["node", "optimized_calorie_bot.js"]