#pragma once

#include <Arduino.h>
#include <time.h>

// Интерфейс модуля времени
void initTime();
String getCurrentTimeStr();     // Возвращает "HH:MM:SS" для верхнего статус-бара
String getCurrentTimeShort();    // Возвращает "HH:MM" для сравнения с расписанием
uint32_t getCurrentDayOfYear(); // Возвращает день года (1-366) для защиты от повторного полива
bool isTimeValid();             // Возвращает true, если время успешно синхронизировано с интернетом