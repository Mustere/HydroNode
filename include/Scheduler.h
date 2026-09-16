#pragma once

#include <Arduino.h>
#include <ArduinoJson.h>
#include <LittleFS.h>

// Максимальное количество таймеров полива
const int MAX_SCHEDULE_SLOTS = 35;

// Структура для одной ячейки расписания
struct ScheduleSlot {
    int id;           // Номер ячейки (1..MAX)
    String time;      // Время в формате "HH:MM"
    int volume;       // Объем воды в мл
    bool active;      // Флаг активности таймера
    uint32_t lastWateredDay; // Хранение дня последнего успешного полива
};

// Экспортируем массив расписания наружу, чтобы Web-интерфейс мог его читать/отдавать
extern ScheduleSlot schedule[MAX_SCHEDULE_SLOTS];

// Интерфейс модуля расписания
void initScheduler();
void checkScheduler(); // Будет вызываться в loop() для проверки времени полива
bool saveScheduleConfig(JsonArray jsonArray); // Сохранение расписания во Flash
bool markSlotAsWatered(int slotId, uint32_t dayOfYear);