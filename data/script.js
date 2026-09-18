document.addEventListener('DOMContentLoaded', async () => {
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
        form.style.maxHeight = '0px';
        section.classList.add('collapsed');
        btnCollapse.textContent = '↓';
    } else {
        section.classList.remove('collapsed');
        btnCollapse.textContent = '↑';

        form.style.maxHeight = 'none'; 

        const fullHeight = form.scrollHeight; 
        form.style.maxHeight = '0px'; 
        form.offsetHeight;
        form.style.maxHeight = fullHeight + 'px';
    }
    }

    const savedStatus = localStorage.getItem('sys_control_collapsed');
    const isCollapsed = savedStatus !== null ? savedStatus === 'true' : true;

    setTimeout(() => toggleCollapse(isCollapsed), 50);

    if (btnCollapse) {
    btnCollapse.addEventListener('click', () => {
        const currentlyCollapsed = section.classList.contains('collapsed');
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
            const [espTime, espMode, espPump] = String(event.data || '').split('|');

            if (netStatusEl && espMode) {
                netStatusEl.textContent = espMode;
                netStatusEl.style.color = espMode === 'STA' ? 'var(--primary-color)' : '#e67e22';
            }

            if (espTime && espTime !== '--:--:--') {
                startLocalClock(espTime);
            } else if (ntpTimeEl) {
                ntpTimeEl.textContent = 'Синхронизация...';
            }

            if (typeof espPump !== 'undefined') {
                setPumpStatus(espPump === 'ON', espPump === 'ON' ? 'Включен' : 'Выключен');
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

    let socket = null;

    function connectWebSocket() {
        if (socket && (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING)) {
            return socket;
        }

        const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
        socket = new WebSocket(`${protocol}//${window.location.host}/ws`);

        socket.addEventListener('open', () => {
            console.log('WebSocket connected');
            sendSocketMessage({ type: 'get_schedule' });
        });

        socket.addEventListener('close', () => {
            console.warn('WebSocket connection closed');
        });

        socket.addEventListener('error', () => {
            console.warn('WebSocket connection error');
        });

        return socket;
    }

    function sendSocketMessage(message) {
        const ws = connectWebSocket();
        if (ws && ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify(message));
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
        manualToggleBtn.addEventListener('click', async () => {
            const volume = getManualVolume();

            if (volume === null) {
                alert(`Введите объем полива от ${MANUAL_VOLUME_MIN} до ${MANUAL_VOLUME_MAX} мл.`);
                manualVolumeInput?.focus();
                return;
            }

            const ok = confirm(`Запустить полив на ${volume} мл?`);
            if (!ok) return;

            const payload = {
                volume: volume
            };

            if (wateringStatusEl) {
                wateringStatusEl.textContent = 'Отправка...';
                wateringStatusEl.className = 'state-off';
            }

            try {
                const response = await fetch('/api/toggle-pump', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(payload)
                });

                const result = await response.json().catch(() => ({}));
                if (response.ok && result.status === 'ok') {
                    const active = Boolean(result.pump_active);
                    if (wateringStatusEl) {
                        if (active) {
                            wateringStatusEl.textContent = volume > 0 ? `Запущен на ${volume} мл` : 'Включен';
                            wateringStatusEl.className = 'state-on';
                        } else {
                            wateringStatusEl.textContent = 'Выключен';
                            wateringStatusEl.className = 'state-off';
                        }
                    }

                    manualToggleBtn.disabled = true;
                    manualToggleBtn.textContent = 'Отправлено';
                    setTimeout(syncManualButtonState, 1200);
                } else {
                    throw new Error(result.message || 'Не удалось запустить полив');
                }
            } catch (error) {
                console.error('Manual watering failed', error);
                if (wateringStatusEl) {
                    wateringStatusEl.textContent = 'Ошибка отправки';
                    wateringStatusEl.className = 'state-off';
                }
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
            button.disabled = false;
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

        schedule = data.schedule.map(rule => {
            const rawDay = Number(rule.day);
            return {
                day: Number.isFinite(rawDay) ? rawDay : 1,
                time: String(rule.time || '08:00'),
                volume: Number(rule.volume),
                active: Boolean(rule.active)
            };
        });

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

    const wifiForm = document.getElementById('wifi-form');
    if (wifiForm) {
        wifiForm.addEventListener('submit', async (event) => {
            event.preventDefault();

            const formData = new FormData(wifiForm);
            const payload = {
                wifi_mode: formData.get('wifi_mode') || 'STA',
                ssid: formData.get('ssid') || '',
                password: formData.get('password') || ''
            };

            const submitBtn = wifiForm.querySelector('button[type="submit"]');
            const originalText = submitBtn?.textContent || 'Применить';
            if (submitBtn) {
                submitBtn.disabled = true;
                submitBtn.textContent = 'Сохранение...';
            }

            try {
                const response = await fetch('/api/save-wifi', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(payload)
                });

                const result = await response.json().catch(() => ({}));
                if (response.ok && result.status === 'ok') {
                    alert(result.message || 'Настройки Wi-Fi сохранены. Устройство перезагружается...');
                } else {
                    alert(result.message || 'Не удалось сохранить настройки Wi-Fi');
                }
            } catch (error) {
                console.error('Wi-Fi save failed', error);
                alert('Не удалось отправить запрос на сохранение Wi-Fi');
            } finally {
                if (submitBtn) {
                    submitBtn.disabled = false;
                    submitBtn.textContent = originalText;
                }
            }
        });
    }

    function setPumpStatus(active, text) {
        if (!wateringStatusEl) return;
        wateringStatusEl.textContent = text || (active ? 'Включен' : 'Выключен');
        wateringStatusEl.className = active ? 'state-on' : 'state-off';
    }

    async function loadConfig() {
        try {
            const response = await fetch('/api/get-config');
            if (!response.ok) return;

            const data = await response.json();
            const modeSelect = document.getElementById('wifi-mode');
            const ssidInput = document.getElementById('wifi-ssid');
            const passInput = document.getElementById('wifi-pass');

            if (modeSelect) modeSelect.value = String(data.wifi_mode || 'STA');
            if (ssidInput) ssidInput.value = String(data.ssid || '');
            if (passInput) passInput.value = String(data.password || '');
        } catch (err) {
            console.warn('Не удалось загрузить конфигурацию Wi-Fi:', err);
        }
    }

    async function loadPumpStatus() {
        try {
            const response = await fetch('/api/get-status');
            if (!response.ok) return;

            const data = await response.json();
            setPumpStatus(Boolean(data.pump_active), data.pump_active ? 'Включен' : 'Выключен');
        } catch (err) {
            console.warn('Не удалось загрузить статус насоса:', err);
        }
    }

    async function loadScheduleFromServer() {
        try {
            const response = await fetch('/api/get-schedule');
            if (!response.ok) return;

            const data = await response.json();
            loadSchedule(data);
        } catch (err) {
            console.warn('Не удалось загрузить расписание:', err);
        }
    }

    await loadConfig();
    await loadPumpStatus();
    await loadScheduleFromServer();

    /*
    ============================================================
    ПРИЕМ ДАННЫХ ОТ WEB SOCKET
    ============================================================
    */

    function handleSocketMessage(event) {
        try {
            const data = JSON.parse(event.data);

            if (data.type === 'schedule_data') {
                loadSchedule(data);
            }

            if (data.type === 'status') {
                setPumpStatus(Boolean(data.pump_active), data.pump_active ? 'Включен' : 'Выключен');
            }

            if (data.type === 'watering_status') {
                if (wateringStatusEl) {
                    const active = Boolean(data.active);
                    wateringStatusEl.textContent = active ? String(data.text || 'Включен') : 'Выключен';
                    wateringStatusEl.className = active ? 'state-on' : 'state-off';
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
    }

    connectWebSocket();
    if (socket) {
        socket.addEventListener('message', handleSocketMessage);
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
        event.preventDefault();

        const file = otaFileInput.files[0];
        if (!file) return;

        const xhr = new XMLHttpRequest();

        otaProgressContainer.style.display = 'block';
        otaSubmitBtn.disabled = true;
        otaFileInput.disabled = true;
        otaStatusText.textContent = 'Загрузка прошивки в память ESP8266...';

        xhr.upload.addEventListener('progress', (e) => {
            if (e.lengthComputable) {
                const percentComplete = Math.round((e.loaded / e.total) * 100);
                otaProgressBar.style.width = percentComplete + '%';
                otaStatusText.textContent = `Загружено: ${percentComplete}%`;
            }
        });

        xhr.addEventListener('load', () => {
            try {
                const result = JSON.parse(xhr.responseText || '{}');
                if (xhr.status === 200 && result.status === 'ok') {
                    otaStatusText.textContent = '🎉 ' + result.message;
                    otaStatusText.style.color = 'var(--primary-color)';

                    let countdown = 10;
                    const timer = setInterval(() => {
                        countdown--;
                        otaStatusText.textContent = `Перезагрузка HydroNode... Ожидайте ${countdown} сек.`;
                        if (countdown <= 0) {
                            clearInterval(timer);
                            window.location.reload();
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

        xhr.addEventListener('error', () => {
            otaStatusText.textContent = '❌ Критическая ошибка сети при передаче данных.';
            otaStatusText.style.color = 'var(--danger-color)';
            resetOtaForm();
        });

        xhr.open('POST', '/api/update');
        xhr.send(file);
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