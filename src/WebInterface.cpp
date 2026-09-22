#include "WebInterface.h"
#include "ConfigManager.h"
#include "Scheduler.h"
#include "TimeManager.h"
#include "PumpManager.h"
#include <ESP8266WiFi.h>
#include <ESP8266WiFi.h>
#include <Updater.h>

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

static void sendSchedulePayload(AsyncWebSocketClient *client) {
    JsonDocument doc;
    doc["type"] = "schedule_data";
    JsonArray arr = doc["schedule"].to<JsonArray>();

    for (int i = 0; i < MAX_SCHEDULE_SLOTS; i++) {
        bool hasRule = schedule[i].volume > 0 || schedule[i].active || schedule[i].time != "00:00";
        if (!hasRule) continue;

        JsonObject slot = arr.add<JsonObject>();
        slot["id"] = schedule[i].id;
        slot["day"] = schedule[i].day;
        slot["time"] = schedule[i].time;
        slot["volume"] = schedule[i].volume;
        slot["active"] = schedule[i].active;
    }

    String response;
    serializeJson(doc, response);
    client->text(response);
}

static void sendStatusPayload(AsyncWebSocketClient *client) {
    JsonDocument doc;
    doc["type"] = "status";
    doc["pump_active"] = isPumpOn();

    String response;
    serializeJson(doc, response);
    client->text(response);
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

    ws.onEvent([](AsyncWebSocket *server, AsyncWebSocketClient *client, AwsEventType type, void *arg, uint8_t *data, size_t len) {
        switch (type) {
            case WS_EVT_CONNECT:
                Serial.printf("[WebSocket] client #%u connected\n", client->id());
                sendSchedulePayload(client);
                sendStatusPayload(client);
                break;

            case WS_EVT_DISCONNECT:
                Serial.printf("[WebSocket] client #%u disconnected\n", client->id());
                break;

            case WS_EVT_DATA: {
                String payload;
                for (size_t i = 0; i < len; ++i) {
                    payload += (char)data[i];
                }

                JsonDocument doc;
                DeserializationError error = deserializeJson(doc, payload);
                if (error) {
                    client->text("{\"type\":\"error\",\"message\":\"Invalid JSON\"}");
                    break;
                }

                const String messageType = doc["type"] | "";
                if (messageType == "schedule_save") {
                    JsonArray arr = doc["schedule"].as<JsonArray>();
                    bool ok = saveScheduleConfig(arr);
                    JsonDocument reply;
                    reply["type"] = ok ? "schedule_saved" : "schedule_error";
                    reply["status"] = ok ? "ok" : "error";
                    String response;
                    serializeJson(reply, response);
                    client->text(response);
                } else if (messageType == "manual_watering_start") {
                    const int volume = doc["volume_ml"] | 0;
                    if (volume > 0) {
                        executeWatering(volume);
                    } else {
                        togglePumpManual(true);
                    }

                    JsonDocument reply;
                    reply["type"] = "watering_status";
                    reply["text"] = volume > 0 ? "Запущен" : "Включен";
                    reply["active"] = true;
                    String response;
                    serializeJson(reply, response);
                    client->text(response);
                } else if (messageType == "get_schedule") {
                    sendSchedulePayload(client);
                } else if (messageType == "get_status") {
                    sendStatusPayload(client);
                }
                break;
            }

            default:
                break;
        }
    });

    // 2. Отдача статических файлов интерфейса из LittleFS
    server.serveStatic("/", LittleFS, "/").setDefaultFile("index.html");

    // 3. API, прием и обработка настроек Wi-Fi из HTML-формы
    server.on("/api/save-wifi", HTTP_POST, [](AsyncWebServerRequest *request) {}, NULL,
    [](AsyncWebServerRequest *request, uint8_t *data, size_t len, size_t index, size_t total) {
        JsonDocument doc;
        DeserializationError error = deserializeJson(doc, (const char*)data, len);

        String mode = "STA";
        String ssid = "";
        String password = "";

        if (error && request->hasArg("ssid")) {
            mode = request->arg("wifi_mode");
            ssid = request->arg("ssid");
            password = request->arg("password");
        } else if (!error) {
            mode = doc["wifi_mode"] | "STA";
            ssid = doc["ssid"] | "";
            password = doc["password"] | "";
        } else {
            request->send(400, "application/json", "{\"status\":\"error\",\"message\":\"Неверный JSON\"}");
            return;
        }

        Serial.println("\n[Web] Получены настройки Wi-Fi:");
        Serial.printf("Режим: %s | SSID: %s\n", mode.c_str(), ssid.c_str());

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

    // API: Отдача расписания для динамической генерации строк таблицы в JS
    server.on("/api/get-schedule", HTTP_GET, [](AsyncWebServerRequest *request) {
        JsonDocument doc;
        JsonArray arr = doc["schedule"].to<JsonArray>();

        for (int i = 0; i < MAX_SCHEDULE_SLOTS; i++) {
            bool hasRule = schedule[i].volume > 0 || schedule[i].active || schedule[i].time != "00:00";
            if (!hasRule) continue;

            JsonObject slot = arr.add<JsonObject>();
            slot["id"] = schedule[i].id;
            slot["day"] = schedule[i].day;
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

    server.on("/api/get-config", HTTP_GET, [](AsyncWebServerRequest *request) {
        JsonDocument doc;
        doc["wifi_mode"] = currentConfig.mode;
        doc["ssid"] = currentConfig.ssid;
        doc["password"] = currentConfig.password;

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

    // API: Беспроводное обновление прошивки (Web OTA)
    server.on("/api/update", HTTP_POST, [](AsyncWebServerRequest *request) {
        // Этот коллбек вызывается ПОСЛЕ завершения загрузки всего файла
        bool updateError = Update.hasError();
        
        // Формируем HTTP-ответ
        AsyncWebServerResponse *response = request->beginResponse(
            updateError ? 500 : 200, 
            "application/json", 
            updateError ? "{\"status\":\"error\",\"message\":\"Ошибка записи во Flash!\"}" 
                        : "{\"status\":\"ok\",\"message\":\"Прошивка загружена. Перезагрузка...\"}"
        );
        response->addHeader("Connection", "close");
        request->send(response);
        
        // Если ошибок нет, запускаем отложенный ребут микроконтроллера
        if (!updateError) {
            Serial.println("[OTA] Обновление успешно завершено. Запрос ребута...");
            requestReboot();
        }
    }, [](AsyncWebServerRequest *request, String filename, size_t index, uint8_t *data, size_t len, bool final) {
        // Этот коллбек обрабатывает файл КУСКАМИ (потоком) в процессе загрузки
        if (!index) {
            Serial.printf("[OTA] Старт обновления. Файл: %s\n", filename.c_str());
            
            // Переводим Updater в асинхронный режим работы
            Update.runAsync(true);
            
            // Рассчитываем максимальный доступный размер под прошивку во Flash
            uint32_t maxSketchSpace = (ESP.getFreeSketchSpace() - 0x1000) & 0xFFFFF000;
            
            if (!Update.begin(maxSketchSpace, U_FLASH)) { // U_FLASH указывает, что шьем код прошивки
                Update.printError(Serial);
            }
        }
        
        // Пишем текущий кусок данных во флеш-память, если нет ошибок
        if (!Update.hasError()) {
            if (Update.write(data, len) != len) {
                Update.printError(Serial);
            }
        }
        
        // Если это последний кусок файла, финализируем прошивку
        if (final) {
            if (Update.end(true)) {
                Serial.printf("[OTA] Успешно записано байт: %u\n", index + len);
            } else {
                Update.printError(Serial);
            }
        }
    });

    // Запуск сервера после регистрации всех маршрутов
    server.begin();
    Serial.println("[Web] HTTP-сервер успешно запущен");
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
        String payload = timeStr + "|" + modeStr + "|" + pumpStr;

        // Отправляем объединенное событие в браузер
        events.send(payload.c_str(), "status_tick");
    }
}