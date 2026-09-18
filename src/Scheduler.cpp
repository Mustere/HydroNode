#include "Scheduler.h"
#include "TimeManager.h"

// Создаем глобальный массив расписания
ScheduleSlot schedule[MAX_SCHEDULE_SLOTS];

const char* SCHED_CONFIG_FILE = "/config.json";

extern void executeWatering(int volumeML); 
extern bool markSlotAsWatered(int slotId, uint32_t dayOfYear);

// Инициализация расписания значениями по умолчанию
void initScheduler() {
    // Сначала заполняем массив дефолтными пустыми значениями
    for (int i = 0; i < MAX_SCHEDULE_SLOTS; i++) {
        schedule[i].id = i + 1;
        schedule[i].day = 1;
        schedule[i].time = "00:00";
        schedule[i].volume = 0;
        schedule[i].active = false;
        schedule[i].lastWateredDay = 0;
    }

    // Если файл конфигурации существует, пытаемся прочитать расписание оттуда
    if (LittleFS.exists(SCHED_CONFIG_FILE)) {
        File configFile = LittleFS.open(SCHED_CONFIG_FILE, "r");
        if (configFile) {
            JsonDocument doc;
            DeserializationError error = deserializeJson(doc, configFile);
            configFile.close();

            if (!error && doc["schedule"].is<JsonArray>()) {
                JsonArray arr = doc["schedule"].as<JsonArray>();
                int index = 0;
                for (JsonVariant v : arr) {
                    if (index >= MAX_SCHEDULE_SLOTS) break;

                    schedule[index].id = v["id"] | (index + 1);
                    int loadedDay = v["day"].is<int>() ? v["day"].as<int>() : 1;
                    schedule[index].day = loadedDay;
                    schedule[index].time = v["time"] | "00:00";
                    schedule[index].volume = v["volume"] | 0;
                    schedule[index].active = v["active"] | false;
                    index++;
                }
                Serial.printf("[Scheduler] Успешно загружено %d ячеек расписания\n", index);
                return;
            }
        }
    }
    Serial.println("[Scheduler] Расписание инициализировано по умолчанию");
}

// Сохранение расписания во Flash ( LittleFS )
bool saveScheduleConfig(JsonArray jsonArray) {
    JsonDocument doc;
    
    // 1. Считываем текущий файл, чтобы сохранить настройки Wi-Fi
    if (LittleFS.exists(SCHED_CONFIG_FILE)) {
        File configFile = LittleFS.open(SCHED_CONFIG_FILE, "r");
        if (configFile) {
            deserializeJson(doc, configFile);
            configFile.close();
        }
    }

    // 2. Полностью перезаписываем или создаем ветку "schedule" в JSON
    doc.remove("schedule"); // Удаляем старое, если было
    JsonArray schedTarget = doc["schedule"].to<JsonArray>();

    int index = 0;
    for (JsonVariant v : jsonArray) {
        if (index >= MAX_SCHEDULE_SLOTS) break;

        JsonObject slotObj = schedTarget.add<JsonObject>();
        slotObj["id"] = v["id"] | (index + 1);
        int storedDay = v["day"].is<int>() ? v["day"].as<int>() : 1;
        slotObj["day"] = storedDay;
        slotObj["time"] = v["time"] | "00:00";
        slotObj["volume"] = v["volume"] | 0;
        slotObj["active"] = v["active"] | false;

        // Также сразу обновляем данные в оперативной памяти (ОЗУ)
        schedule[index].id = slotObj["id"];
        schedule[index].day = slotObj["day"];
        schedule[index].time = slotObj["time"].as<String>();
        schedule[index].volume = slotObj["volume"];
        schedule[index].active = slotObj["active"];
        index++;
    }

    // Очищаем оставшиеся ячейки расписания, если их стало меньше
    for (; index < MAX_SCHEDULE_SLOTS; index++) {
        schedule[index].id = index + 1;
        schedule[index].day = 1;
        schedule[index].time = "00:00";
        schedule[index].volume = 0;
        schedule[index].active = false;
        schedule[index].lastWateredDay = 0;
    }

    // 3. Записываем объединенный JSON обратно во Flash
    File configFile = LittleFS.open(SCHED_CONFIG_FILE, "w");
    if (!configFile) {
        Serial.println("[Scheduler] Ошибка открытия файла для записи расписания!");
        return false;
    }

    if (serializeJson(doc, configFile) == 0) {
        Serial.println("[Scheduler] Ошибка сериализации JSON при записи");
        configFile.close();
        return false;
    }

    configFile.close();
    Serial.println("[Scheduler] Новое расписание успешно сохранено во Flash");
    return true;
}

// Фоновая проверка времени (будет добавлена логика сравнения с NTP часами)
// Добавляем в структуру ячейки (в Scheduler.h) новое поле:
// uint32_t lastWateredDay = 0; // Хранит день года (1-365), когда полив успешно отработал

void checkScheduler() {
    // Безопасность: если время еще не синхронизировано с интернетом, поливать нельзя
    if (!isTimeValid()) return;

    static unsigned long lastCheck = 0;
    // Проверяем расписание каждые 10 секунд (как в вашем исходном коде)
    if (millis() - lastCheck < 10000) return; 
    lastCheck = millis();

    // Получаем текущее время через стандартную библиотеку <time.h> из TimeManager
    time_t now = time(nullptr);
    struct tm* timeInfo = localtime(&now);

    int currentHour = timeInfo->tm_hour;
    int currentMinute = timeInfo->tm_min;
    
    // Получаем день года (1-366) для защиты от повторного полива
    uint32_t currentDayOfYear = getCurrentDayOfYear(); 

    // Переводим текущее время в минуты от начала суток
    int currentMinutesSinceMidnight = currentHour * 60 + currentMinute;

    for (int i = 0; i < MAX_SCHEDULE_SLOTS; i++) {
        // Пропускаем неактивные или пустые ячейки
        if (!schedule[i].active || schedule[i].volume <= 0) continue;

        // Запускаем ячейку только в указанный день недели (tm_wday: 0 = воскресенье)
        if (schedule[i].day != timeInfo->tm_wday) continue;

        // Парсим строку времени сохраненной ячейки (например, "14:30") в числа
        int targetHour = schedule[i].time.substring(0, 2).toInt();
        int targetMinute = schedule[i].time.substring(3, 5).toInt();

        // Переводим целевое время ячейки в минуты от начала суток
        int targetMinutesSinceMidnight = targetHour * 60 + targetMinute;

        // ВАШЕ НАДЕЖНОЕ ИНТЕРВАЛЬНОЕ УСЛОВИЕ: 
        // 1. Время полива уже наступило или прошло
        // 2. С момента целевого времени прошло не более 15 минут (окно на случай ребута)
        // 3. Сегодня этот таймер ЕЩЕ НЕ НАЖИМАЛСЯ
        if (currentMinutesSinceMidnight >= targetMinutesSinceMidnight && 
            currentMinutesSinceMidnight <= (targetMinutesSinceMidnight + 15) && 
            schedule[i].lastWateredDay != currentDayOfYear) {
            
            Serial.printf("[Scheduler] Сработало расписание! Ячейка №%d (Задано: %s, Сейчас: %02d:%02d)\n", 
                          schedule[i].id, schedule[i].time.c_str(), currentHour, currentMinute);
            
            // Физически включаем мотор
            executeWatering(schedule[i].volume);
            
            // Записываем отметку дня во Flash (LittleFS), чтобы защититься от дублирования при ребуте
            markSlotAsWatered(schedule[i].id, currentDayOfYear);
            
            Serial.printf("[Scheduler] Полив по ячейке %d выполнен успешно!\n", schedule[i].id);
        }
    }
}

bool markSlotAsWatered(int slotId, uint32_t dayOfYear) {
    if (!LittleFS.exists(SCHED_CONFIG_FILE)) return false;

    JsonDocument doc;
    File configFile = LittleFS.open(SCHED_CONFIG_FILE, "r");
    if (configFile) {
        deserializeJson(doc, configFile);
        configFile.close();
    }

    JsonArray arr = doc["schedule"].as<JsonArray>();
    bool found = false;

    // Ищем нужную ячейку по ID и дописываем ей дату полива
    for (JsonVariant v : arr) {
        if ((v["id"] | 0) == slotId) {
            v["lastWateredDay"] = dayOfYear;
            found = true;
            break;
        }
    }

    if (!found) return false;

    // Перезаписываем обновленный файл
    configFile = LittleFS.open(SCHED_CONFIG_FILE, "w");
    if (!configFile) return false;

    serializeJson(doc, configFile);
    configFile.close();

    // Синхронизируем оперативную память
    schedule[slotId - 1].lastWateredDay = dayOfYear; 
    return true;
}

