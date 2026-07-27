document.addEventListener('DOMContentLoaded', () => {
    /*
    ============================================================
    БАЗОВЫЕ ЭЛЕМЕНТЫ UI
    ============================================================
    */

    const titleEl = document.querySelector('header h1');
    if (titleEl) {
        titleEl.textContent = 'HydroNode Pump Control';
    }

    const section = document.querySelector('.tab-content.active');
    const form = section?.querySelector('.tab-twice');
    const btnCollapse = section?.querySelector('.btn-collapse');

    function toggleCollapse(isCollapsed) {
        if (!section || !form || !btnCollapse) return;

        if (isCollapsed) {
            form.style.display = 'none';
            section.classList.add('collapsed');
            btnCollapse.textContent = '↓';
        } else {
            form.style.display = 'flex'; // Используем flex, чтобы панели встали в ряд (50% + 50%)
            section.classList.remove('collapsed');
            btnCollapse.textContent = '↑';
        }
    }

    // Изменили ключ на sys_control_collapsed, так как сворачивается вся панель, а не только Wi-Fi
    const savedStatus = localStorage.getItem('sys_control_collapsed');
    const isCollapsed = savedStatus !== null ? savedStatus === 'true' : true;
    toggleCollapse(isCollapsed);

    if (btnCollapse) {
        btnCollapse.addEventListener('click', () => {
            const currentlyCollapsed = form?.style.display === 'none';
            const nextState = !currentlyCollapsed;
            toggleCollapse(nextState);
            localStorage.setItem('sys_control_collapsed', String(nextState));
        });
    }


    /*
    ============================================================
    СТАТУС И ВРЕМЯ ПО SSE
    ============================================================
    */

    const ntpTimeEl = document.getElementById('ntp-time');
    const netStatusEl = document.getElementById('net-status');

    let localSeconds = 0;
    let clockInterval = null;

    function startLocalClock(timeString) {
        if (!ntpTimeEl) return;

        if (clockInterval) clearInterval(clockInterval);

        const parts = String(timeString).split(':').map(Number);
        if (parts.length !== 3 || parts.some(Number.isNaN)) return;

        localSeconds = parts[0] * 3600 + parts[1] * 60 + parts[2];

        ntpTimeEl.textContent = String(parts[0]).padStart(2, '0') + ':' +
                                String(parts[1]).padStart(2, '0') + ':' +
                                String(parts[2]).padStart(2, '0');

        clockInterval = setInterval(() => {
            localSeconds += 1;
            if (localSeconds >= 86400) localSeconds = 0;

            const h = Math.floor(localSeconds / 3600);
            const m = Math.floor((localSeconds % 3600) / 60);
            const s = localSeconds % 60;

            ntpTimeEl.textContent =
                String(h).padStart(2, '0') + ':' +
                String(m).padStart(2, '0') + ':' +
                String(s).padStart(2, '0');
        }, 1000);
    }

    if (window.EventSource) {
        const source = new EventSource('/events');

        source.addEventListener('status_tick', (event) => {
            const [espTime, espMode] = String(event.data || '').split('|');

            if (netStatusEl && espMode) {
                netStatusEl.textContent = espMode;
                netStatusEl.style.color = espMode === 'STA' ? 'var(--primary-color)' : '#e67e22';
            }

            if (espTime && espTime !== '--:--:--') {
                startLocalClock(espTime);
            } else if (ntpTimeEl) {
                ntpTimeEl.textContent = 'Синхронизация...';
            }
        }, false);

        source.addEventListener('error', (e) => {
            if (e.readyState === EventSource.CLOSED) {
                console.log('SSE соединение закрыто');
            } else {
                if (ntpTimeEl) ntpTimeEl.textContent = '--:--:--';
                if (netStatusEl) {
                    netStatusEl.textContent = 'ОФФЛАЙН';
                    netStatusEl.style.color = 'var(--danger-color)';
                }
            }
        }, false);
    }

    /*
    ============================================================
    WEB SOCKET HELPER
    ============================================================
    */

    function sendSocketMessage(message) {
        if (typeof socket !== 'undefined' && socket && socket.readyState === WebSocket.OPEN) {
            socket.send(JSON.stringify(message));
            return true;
        }

        console.warn('WebSocket недоступен, сообщение не отправлено:', message);
        return false;
    }

    /*
    ============================================================
    РУЧНОЙ ПОЛИВ
    ============================================================
    */

    const wateringStatusEl = document.getElementById('watering-status');
    const manualVolumeInput = document.getElementById('manual-volume-input');
    const manualToggleBtn = document.getElementById('manual-toggle-btn');

    const MANUAL_VOLUME_MIN = 1;
    const MANUAL_VOLUME_MAX = 9999;

    function getManualVolume() {
        if (!manualVolumeInput) return null;

        const raw = String(manualVolumeInput.value || '').trim();
        if (raw === '') return null;

        const value = Number(raw);
        if (!Number.isFinite(value) || !Number.isInteger(value)) return null;

        if (value < MANUAL_VOLUME_MIN || value > MANUAL_VOLUME_MAX) return null;

        return value;
    }

    function syncManualButtonState() {
        if (!manualToggleBtn) return;

        const volume = getManualVolume();
        manualToggleBtn.disabled = volume === null;
        manualToggleBtn.textContent = volume === null
            ? 'Укажите объем'
            : `Полив ${volume} мл`;
    }

    if (manualVolumeInput) {
        manualVolumeInput.min = String(MANUAL_VOLUME_MIN);
        manualVolumeInput.max = String(MANUAL_VOLUME_MAX);
        manualVolumeInput.step = '1';
        manualVolumeInput.addEventListener('input', syncManualButtonState);
        manualVolumeInput.addEventListener('change', syncManualButtonState);
    }

    if (manualToggleBtn) {
        manualToggleBtn.addEventListener('click', () => {
            const volume = getManualVolume();

            if (volume === null) {
                alert(`Введите объем полива от ${MANUAL_VOLUME_MIN} до ${MANUAL_VOLUME_MAX} мл.`);
                manualVolumeInput?.focus();
                return;
            }

            const ok = confirm(`Запустить полив на ${volume} мл?`);
            if (!ok) return;

            const payload = {
                type: 'manual_watering_start',
                volume_ml: volume
            };

            const sent = sendSocketMessage(payload);

            if (wateringStatusEl) {
                wateringStatusEl.textContent = sent ? `Запущен на ${volume} мл` : 'Ошибка отправки';
                wateringStatusEl.className = sent ? 'state-on' : 'state-off';
            }

            if (sent) {
                manualToggleBtn.disabled = true;
                manualToggleBtn.textContent = 'Отправлено';
                setTimeout(syncManualButtonState, 1200);
            }
        });
    }

    syncManualButtonState();

    /*
    ============================================================
    РАСПИСАНИЕ
    ============================================================
    */

    const scheduleForm = document.getElementById('schedule-form');
    const scheduleTable = document.getElementById('schedule-table');
    const scheduleBody = scheduleTable?.querySelector('tbody');
    const addRuleButton = document.querySelector('.btn-add');
    const btnAdd = document.querySelector('.btn-add');

    let schedule = [];

    const daysOfWeek = [
        { value: 1, name: 'Понедельник' },
        { value: 2, name: 'Вторник' },
        { value: 3, name: 'Среда' },
        { value: 4, name: 'Четверг' },
        { value: 5, name: 'Пятница' },
        { value: 6, name: 'Суббота' },
        { value: 0, name: 'Воскресенье' }
    ];
    if (btnAdd) {
        function updateAddButtonText() {
            if (window.innerWidth <= 768) {
                btnAdd.textContent = '+';
            } else {
                btnAdd.textContent = '+ Добавить правило';
            }
        }
        updateAddButtonText();
        window.addEventListener('resize', updateAddButtonText);
    }
    function sortSchedule() {
        schedule.sort((a, b) => {
            const dayA = a.day;
            const dayB = b.day;

            if (dayA !== dayB) {
                const normalizedDayA = dayA === 0 ? 7 : dayA;
                const normalizedDayB = dayB === 0 ? 7 : dayB;
                return normalizedDayA - normalizedDayB;
            }

            return String(a.time).localeCompare(String(b.time));
        });
    }

    function renderSchedule() {
        if (!scheduleBody) return;

        scheduleBody.innerHTML = '';

        schedule.forEach((rule, index) => {
            const row = document.createElement('tr');
            // Уникальный ID для генерации уникальных имен полей
            const slotId = index + 1; 

            row.innerHTML = `
                <td>${slotId}</td>

                <td>
                    <div class="select-wrapper" style="width: 100%">
                        <select id="rule-day-${slotId}" name="day_${slotId}" class="rule-day">
                            ${daysOfWeek.map(day => `
                                <option value="${day.value}" ${Number(rule.day) === day.value ? 'selected' : ''}>
                                    ${day.name}
                                </option>
                            `).join('')}
                        </select>
                    </div>
                </td>

                <td>
                    <input
                        type="time"
                        id="rule-time-${slotId}"
                        name="time_${slotId}"
                        class="rule-time"
                        value="${rule.time}"
                    >
                </td>

                <td>
                    <input
                        type="number"
                        id="rule-volume-${slotId}"
                        name="volume_${slotId}"
                        class="rule-volume"
                        min="1"
                        max="9999"
                        step="1"
                        value="${rule.volume}"
                    >
                </td>

                <td>
                    <input
                        type="checkbox"
                        id="rule-active-${slotId}"
                        name="active_${slotId}"
                        class="rule-active"
                        ${rule.active ? 'checked' : ''}
                    >
                </td>

                <td>
                    <button
                        type="button"
                        class="btn-delete"
                        data-index="${index}"
                    >
                        ✕
                    </button>
                </td>
            `;

            scheduleBody.appendChild(row);
        });

        updateDeleteButtons();
    }


    function updateDeleteButtons() {
        if (!scheduleBody) return;

        const deleteButtons = scheduleBody.querySelectorAll('.btn-delete');
        deleteButtons.forEach(button => {
            button.disabled = schedule.length <= 1;
        });
    }

    function collectScheduleFromTable() {
        if (!scheduleBody) return [];

        const rows = Array.from(scheduleBody.querySelectorAll('tr'));
        const result = [];

        rows.forEach(row => {
            const dayEl = row.querySelector('.rule-day');
            const timeEl = row.querySelector('.rule-time');
            const volumeEl = row.querySelector('.rule-volume');
            const activeEl = row.querySelector('.rule-active');

            if (!dayEl || !timeEl || !volumeEl || !activeEl) return;

            const day = Number(dayEl.value);
            const time = String(timeEl.value || '00:00');
            const volume = Number(volumeEl.value);
            const active = Boolean(activeEl.checked);

            result.push({
                day: Number.isFinite(day) ? day : 1,
                time,
                volume: Number.isFinite(volume) && volume > 0 ? volume : 1,
                active
            });
        });

        return result;
    }

    function loadSchedule(data) {
        if (!data || !Array.isArray(data.schedule)) return;

        schedule = data.schedule.map(rule => ({
            day: Number(rule.day),
            time: String(rule.time || '08:00'),
            volume: Number(rule.volume),
            active: Boolean(rule.active)
        }));

        sortSchedule();
        renderSchedule();
    }

    if (addRuleButton) {
        addRuleButton.addEventListener('click', () => {
            schedule.push({
                day: 1,
                time: '08:00',
                volume: 500,
                active: true
            });

            sortSchedule();
            renderSchedule();
        });
    }

    if (scheduleBody) {
        scheduleBody.addEventListener('click', (event) => {
            const target = event.target;

            if (!(target instanceof HTMLElement)) return;
            if (!target.classList.contains('btn-delete')) return;

            const index = Number(target.dataset.index);
            if (!Number.isInteger(index)) return;

            schedule.splice(index, 1);

            if (schedule.length === 0) {
                schedule.push({
                    day: 1,
                    time: '08:00',
                    volume: 500,
                    active: true
                });
            }

            sortSchedule();
            renderSchedule();
        });

        scheduleBody.addEventListener('change', (event) => {
            const target = event.target;
            if (!(target instanceof HTMLElement)) return;

            const row = target.closest('tr');
            if (!row) return;

            const rows = Array.from(scheduleBody.querySelectorAll('tr'));
            const index = rows.indexOf(row);
            if (index === -1 || !schedule[index]) return;

            if (target.classList.contains('rule-day')) {
                schedule[index].day = Number(target.value);
            }

            if (target.classList.contains('rule-time')) {
                schedule[index].time = String(target.value || '00:00');
            }

            if (target.classList.contains('rule-volume')) {
                const volume = Number(target.value);
                schedule[index].volume = Number.isFinite(volume) && volume > 0 ? volume : 1;
                target.value = String(schedule[index].volume);
            }

            if (target.classList.contains('rule-active')) {
                schedule[index].active = target.checked;
            }

            if (
                target.classList.contains('rule-day') ||
                target.classList.contains('rule-time')
            ) {
                sortSchedule();
                renderSchedule();
            }
        });
    }

    if (scheduleForm) {
        scheduleForm.addEventListener('submit', (event) => {
            event.preventDefault();

            schedule = collectScheduleFromTable();
            sortSchedule();

            const payload = {
                type: 'schedule_save',
                schedule: schedule
            };

            console.log('Отправка расписания:', payload);

            const sent = sendSocketMessage(payload);

            if (sent) {
                alert('Расписание сохранено');
            } else {
                alert('Не удалось отправить расписание: WebSocket недоступен');
            }
        });
    }

    /*
    ============================================================
    НАЧАЛЬНОЕ РАСПИСАНИЕ / ЗАГРУЗКА
    ============================================================
    */

    schedule = [
        { day: 1, time: '08:00', volume: 500, active: true },
        { day: 1, time: '18:00', volume: 700, active: true },
        { day: 3, time: '12:30', volume: 400, active: false }
    ];

    sortSchedule();
    renderSchedule();

    /*
    ============================================================
    ПРИЕМ ДАННЫХ ОТ WEB SOCKET
    ============================================================
    */

    if (typeof socket !== 'undefined' && socket) {
        socket.addEventListener('message', (event) => {
            try {
                const data = JSON.parse(event.data);

                if (data.type === 'schedule_data') {
                    loadSchedule(data);
                }

                if (data.type === 'watering_status') {
                    if (wateringStatusEl) {
                        wateringStatusEl.textContent = String(data.text || '---');
                        wateringStatusEl.className = data.active ? 'state-on' : 'state-off';
                    }
                }

                if (data.type === 'manual_watering_done') {
                    if (wateringStatusEl) {
                        wateringStatusEl.textContent = `Готово: ${data.volume_ml || 0} мл`;
                        wateringStatusEl.className = 'state-off';
                    }
                    syncManualButtonState();
                }
            } catch (err) {
                console.warn('Не удалось разобрать сообщение WebSocket:', err);
            }
        });
    }

    // --- 8. УПРАВЛЕНИЕ ОБНОВЛЕНИЕМ ПРОШИВКИ (WEB OTA) ---
    const otaForm = document.getElementById('ota-form');
    const otaFileInput = document.getElementById('ota-file-input');
    const otaSubmitBtn = document.getElementById('ota-submit-btn');
    const otaProgressContainer = document.getElementById('ota-progress-container');
    const otaProgressBar = document.getElementById('ota-progress-bar');
    const otaStatusText = document.getElementById('ota-status-text');

    // Активируем кнопку только когда файл реально выбран
    otaFileInput.addEventListener('change', () => {
        if (otaFileInput.files.length > 0) {
            otaSubmitBtn.disabled = false;
            otaStatusText.textContent = `Выбран файл: ${otaFileInput.files[0].name}`;
            otaStatusText.style.color = 'var(--text-color)';
        } else {
            otaSubmitBtn.disabled = true;
            otaStatusText.textContent = '';
        }
    });

    otaForm.addEventListener('submit', (event) => {
        event.preventDefault(); // Запрещаем стандартное поведение формы

        const file = otaFileInput.files[0];
        if (!file) return;

        // Формируем данные формы для отправки бинарника
        const formData = new FormData();
        formData.append('update', file);

        // Используем XMLHttpRequest для отслеживания прогресса загрузки по сети
        const xhr = new XMLHttpRequest();
        
        // Настраиваем отображение прогресс-бара
        otaProgressContainer.style.display = 'block';
        otaSubmitBtn.disabled = true;
        otaFileInput.disabled = true;
        otaStatusText.textContent = 'Загрузка прошивки в память ESP8266...';

        // Отслеживаем прогресс передачи байт
        xhr.upload.addEventListener('progress', (e) => {
            if (e.lengthComputable) {
                const percentComplete = Math.round((e.loaded / e.total) * 100);
                otaProgressBar.style.width = percentComplete + '%';
                otaStatusText.textContent = `Загружено: ${percentComplete}%`;
            }
        });

        // Обработка завершения запроса
        xhr.addEventListener('load', () => {
            try {
                const result = JSON.parse(xhr.responseText);
                if (xhr.status === 200 && result.status === 'ok') {
                    otaStatusText.textContent = '🎉 ' + result.message;
                    otaStatusText.style.color = 'var(--primary-color)';
                    
                    // Запускаем обратный отсчет до перезагрузки страницы
                    let countdown = 10;
                    const timer = setInterval(() => {
                        countdown--;
                        otaStatusText.textContent = `Перезагрузка HydroNode... Ожидайте ${countdown} сек.`;
                        if (countdown <= 0) {
                            clearInterval(timer);
                            window.location.reload(); // Перезагружаем страницу
                        }
                    }, 1000);
                } else {
                    throw new Error(result.message || 'Ошибка сервера');
                }
            } catch (err) {
                otaStatusText.textContent = `❌ Ошибка обновления: ${err.message}`;
                otaStatusText.style.color = 'var(--danger-color)';
                resetOtaForm();
            }
        });

        // Обработка критических ошибок сети
        xhr.addEventListener('error', () => {
            otaStatusText.textContent = '❌ Критическая ошибка сети при передаче данных.';
            otaStatusText.style.color = 'var(--danger-color)';
            resetOtaForm();
        });

        // Отправляем асинхронный POST запрос на ESP
        xhr.open('POST', '/api/update');
        xhr.send(formData);
    });

    // Функция сброса формы при ошибках
    function resetOtaForm() {
        otaSubmitBtn.disabled = false;
        otaFileInput.disabled = false;
        otaFileInput.value = '';
        setTimeout(() => {
            otaProgressContainer.style.display = 'none';
            otaProgressBar.style.width = '0%';
        }, 5000);
    }

});