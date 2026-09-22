#include "PumpManager.h"

// Производительность помпы: сколько МИЛЛИЛИТРОВ она выдает за ОДНУ СЕКУНДУ.
// Для помпы 3 л/мин = 3000 мл / 60 сек = 50 мл/сек.
const float PUMP_FLOW_RATE = 50.0; 

// Внутренние переменные состояния
static bool pumpState = false;
static unsigned long pumpOffTimer = 0;
static unsigned long pumpDuration = 0;

void initPump() {
    pinMode(PUMP_PIN, OUTPUT);
    digitalWrite(PUMP_PIN, LOW); // По умолчанию насос выключен
    pumpState = false;
    Serial.println("[Pump] Модуль помпы инициализирован на пине GPIO14");
}

bool isPumpOn() {
    return pumpState;
}

// Включение полива на определенный объем в мл
void executeWatering(int volumeML) {
    if (volumeML <= 0) return;
    
    // Если насос уже работает, игнорируем повторный запуск
    if (pumpState) {
        Serial.println("[Pump] Запрос отклонен: насос уже качает воду!");
        return; 
    }

    // Рассчитываем время работы: (Объем / Скорость) * 1000 миллисекунд
    pumpDuration = (unsigned long)((volumeML / PUMP_FLOW_RATE) * 1000.0);

    Serial.printf("[Pump] Старт полива! Объем: %d мл | Расчетное время: %lu мс\n", volumeML, pumpDuration);
    
    // Физически включаем реле
    digitalWrite(PUMP_PIN, HIGH); 
    pumpState = true;
    
    // Засекаем время, когда нужно выключить насос
    pumpOffTimer = millis(); 
}

// Прямое ручное включение/выключение (без таймера объема)
void togglePumpManual(boolean turnOn) {
    if (turnOn) {
        digitalWrite(PUMP_PIN, HIGH);
        pumpState = true;
        pumpOffTimer = 0; // Сбрасываем автоматический таймер, так как включено вручную
        Serial.println("[Pump] Насос включен вручную");
    } else {
        digitalWrite(PUMP_PIN, LOW);
        pumpState = false;
        Serial.println("[Pump] Насос выключен вручную");
    }
}

// Фоновая проверка времени работы (вызывается в loop)
void handlePump() {
    // Если насос включен и запущен автоматический таймер (pumpOffTimer > 0)
    if (pumpState && pumpOffTimer > 0) {
        // Если расчетное время полива подошло к концу
        if (millis() - pumpOffTimer >= pumpDuration) {
            digitalWrite(PUMP_PIN, LOW); // Физически выключаем реле
            pumpState = false;
            pumpOffTimer = 0;
            Serial.println("[Pump] Полив завершен. Насос автоматически выключен по таймеру объема.");
        }
    }
}
