#include "WebInterface.h"
#include "ConfigManager.h"
#include "Scheduler.h"
#include "TimeManager.h"
#include "PumpManager.h"
#include <ESP8266WiFi.h>
#include <ESP8266WiFi.h>

// Определение глобальных объектов
AsyncWebServer server(80);
AsyncWebSocket ws("/ws");
AsyncEventSource events("/events");

// Внутренние переменные модуля (скрыты от main.cpp)
static bool shouldReboot = false;
static unsigned long rebootTimer = 0;

// Вспомогательная функция для запуска отложенной перезагрузки
void requestReboot() {
    shouldReboot = true;
    rebootTimer = millis();
}

// Обработчик неизвестных запросов
static void onRequest(AsyncWebServerRequest *request) {
    request->send(404, "text/plain", "404: Not Found");
}

// Инициализация сервера и регистрация маршрутов (маршрутизатор)
void initWebServer() {
    // 1. Привязка базовых системных хэндлеров
    server.addHandler(&ws);
    server.addHandler(&events);

    // 2. Отдача статических файлов интерфейса из LittleFS
    server.serveStatic("/", LittleFS, "/").setDefaultFile("index.html");

    // 3. API, прием и обработка настроек Wi-Fi из HTML-формы
    server.on("/api/save-wifi", HTTP_POST, [](AsyncWebServerRequest *request) {}, NULL,
    [](AsyncWebServerRequest *request, uint8_t *data, size_t len, size_t index, size_t total) {
        
        JsonDocument doc;
        DeserializationError error = deserializeJson(doc, (const char*)data, len);

        if (error) {
            request->send(400, "application/json", "{\"status\":\"error\",\"message\":\"Неверный JSON\"}");
            return;
        }

        // Вытаскиваем значения полей из формы
        String mode = doc["wifi_mode"] | "STA";
        String ssid = doc["ssid"] | "";
        String password = doc["password"] | "";

        Serial.println("\n[Web] Получены настройки Wi-Fi:");
        Serial.printf("Режим: %s | SSID: %s\n", mode.c_str(), ssid.c_str());

        // ВЫЗЫВАЕМ СОХРАНЕНИЕ ВО ФЛЕШ:
        if (saveWiFiConfig(mode, ssid, password)) {
            request->send(200, "application/json", "{\"status\":\"ok\",\"message\":\"Параметры сохранены во Flash. Перезагрузка...\"}");
            requestReboot();
        } else {
            request->send(500, "application/json", "{\"status\":\"error\",\"message\":\"Ошибка записи во Flash память ESP\"}");
        }
    });

    // 4. Отладочный эндпоинт состояния кучи (heap)
    server.on("/heap", HTTP_GET, [](AsyncWebServerRequest *request) {
        request->send(200, "text/plain", String(ESP.getFreeHeap()));
    });

    // 5. Обработчик "Не найдено"
    server.onNotFound(onRequest);

    // Запуск сервера
    server.begin();
    Serial.println("[Web] HTTP-сервер успешно запущен");

        // API: Отдача расписания для динамической генерации строк таблицы в JS
    server.on("/api/get-schedule", HTTP_GET, [](AsyncWebServerRequest *request) {
    JsonDocument doc;
    JsonArray arr = doc["schedule"].to<JsonArray>(); 

        for (int i = 0; i < MAX_SCHEDULE_SLOTS; i++) {
            JsonObject slot = arr.add<JsonObject>();
            slot["id"] = schedule[i].id;
            slot["time"] = schedule[i].time;
            slot["volume"] = schedule[i].volume;
            slot["active"] = schedule[i].active;
        }

        String response;
        serializeJson(doc, response);
        request->send(200, "application/json", response);
    });

    // API: Прием нового расписания из формы
    server.on("/api/save-schedule", HTTP_POST, [](AsyncWebServerRequest *request) {}, NULL,
    [](AsyncWebServerRequest *request, uint8_t *data, size_t len, size_t index, size_t total) {
        
        JsonDocument doc;
        DeserializationError error = deserializeJson(doc, (const char*)data, len);

        if (error || !doc["schedule"].is<JsonArray>()) {
            request->send(400, "application/json", "{\"status\":\"error\",\"message\":\"Неверный формат расписания\"}");
            return;
        }

        JsonArray arr = doc["schedule"].as<JsonArray>();
        
        // Передаем массив в модуль Scheduler для записи
        if (saveScheduleConfig(arr)) {
            request->send(200, "application/json", "{\"status\":\"ok\",\"message\":\"Расписание успешно обновлено!\"}");
        } else {
            request->send(500, "application/json", "{\"status\":\"error\",\"message\":\"Ошибка сохранения расписания во Flash\"}");
        }
    });

    // API: Получение текущего состояния насоса (для первой загрузки страницы)
    server.on("/api/get-status", HTTP_GET, [](AsyncWebServerRequest *request) {
        JsonDocument doc;
        doc["pump_active"] = isPumpOn();
        
        String response;
        serializeJson(doc, response);
        request->send(200, "application/json", response);
    });

    // API: Управление насосом с веб-панели
    server.on("/api/toggle-pump", HTTP_POST, [](AsyncWebServerRequest *request) {}, NULL,
    [](AsyncWebServerRequest *request, uint8_t *data, size_t len, size_t index, size_t total) {
        
        JsonDocument doc;
        DeserializationError error = deserializeJson(doc, (const char*)data, len);

        if (error) {
            request->send(400, "application/json", "{\"status\":\"error\"}");
            return;
        }

        // Если насос сейчас работает — любая команда с сайта его выключает
        if (isPumpOn()) {
            togglePumpManual(false);
            request->send(200, "application/json", "{\"status\":\"ok\",\"pump_active\":false}");
            return;
        }

        // Если насос выключен, проверяем, передал ли пользователь объем
        int volume = doc["volume"] | 0;

        if (volume > 0) {
            // Запуск полива по точному объему (выключится сам)
            executeWatering(volume);
        } else {
            // Запуск в режиме постоянного потока до повторного клика
            togglePumpManual(true);
        }

        request->send(200, "application/json", "{\"status\":\"ok\",\"pump_active\":true}");
    });

}

// Функция для вызова внутри главного loop()
void handleWebServer() {
    // Безопасный таймер перезагрузки (ждем 2 секунды, пока отправятся HTTP-пакеты)
    if (shouldReboot && (millis() - rebootTimer >= 2000)) {
        Serial.println("[System] Выполнение перезагрузки...");
        ESP.restart();
    }

    // Отправка системного времени на веб-страницу раз в секунду через Server-Sent Events
    static unsigned long lastEventTime = 0;
    if (millis() - lastEventTime >= 60000) { 
        lastEventTime = millis();
        
        String timeStr = getCurrentTimeStr(); // "HH:MM:SS" или "--:--:--"
        String modeStr = (WiFi.getMode() == WIFI_STA) ? "STA" : "AP";
        String pumpStr = isPumpOn() ? "ON" : "OFF";
        String payload = timeStr + "|" + modeStr;

        // Отправляем объединенное событие в браузер
        events.send(payload.c_str(), "status_tick");
    }
}