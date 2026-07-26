#pragma once

#include <Arduino.h>

// Определяем пин, к которому подключен насос
const int PUMP_PIN = 14; 

// Интерфейс модуля помпы
void initPump();
void handlePump(); // Будет вызываться в главном loop() для отсчета времени
void executeWatering(int volumeML); // Запуск полива по объему
void togglePumpManual(boolean turnOn); // Ручное управление
bool isPumpOn(); // Возвращает текущее состояние помпы (для сайта)