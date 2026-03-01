import { createPublicClient, http } from 'https://esm.sh/viem';
import Chart from 'https://esm.sh/chart.js/auto';

// ABIs embedded for standalone execution
const FactoryABI = [
    {
        "name": "getStoreInfo",
        "inputs": [{ "name": "store", "type": "address" }],
        "outputs": [
            { "name": "nickname", "type": "string" },
            { "name": "owner", "type": "address" },
            { "name": "authorizedSensorCount", "type": "uint256" },
            { "name": "deployedBlock", "type": "uint128" },
            { "name": "description", "type": "string" }
        ],
        "stateMutability": "view",
        "type": "function"
    }
];

const StoreABI = [
    {
        "name": "getAllFields",
        "outputs": [{
            "components": [
                { "name": "name", "type": "string" },
                { "name": "unit", "type": "string" },
                { "name": "dtype", "type": "string" }
            ],
            "type": "tuple[]"
        }],
        "stateMutability": "view",
        "type": "function"
    },
    {
        "name": "getLatestRecord",
        "inputs": [{ "name": "sensor", "type": "address" }],
        "outputs": [
            { "name": "", "type": "uint256" },
            { "name": "", "type": "int256[]" }
        ],
        "stateMutability": "view",
        "type": "function"
    },
    {
        "anonymous": false,
        "inputs": [
            { "indexed": true, "name": "sensor", "type": "address" },
            { "indexed": false, "name": "timestamp", "type": "uint256" },
            { "indexed": false, "name": "values", "type": "int256[]" }
        ],
        "name": "RecordStored",
        "type": "event"
    }
];

// Configuration
const JIBCHAIN = {
    id: 8899,
    name: 'JIBCHAIN L1',
    rpcUrls: {
        default: { http: ['https://rpc-l1.jibchain.net'] }
    },
    blockExplorers: {
        default: { url: 'https://exp.jibchain.net' }
    }
};

const client = createPublicClient({
    chain: JIBCHAIN,
    transport: http()
});

const FACTORY_ADDRESS = '0x63bB41b79b5aAc6e98C7b35Dcb0fE941b85Ba5Bb';
const FLOODBOY016_STORE = '0x0994Bc66b2863f8D58C8185b1ed6147895632812';
const UNIVERSAL_SIGNER = '0xcB0e58b011924e049ce4b4D62298Edf43dFF0BDd';

let currentChart = null;
let chartDataCache = [];
let fieldConfigsCache = [];
let lastBlockFetched = 0n;
let pollingInterval = null;

function truncateAddress(address) {
    if (!address) return '';
    return `${address.substring(0, 10)}...${address.substring(address.length - 6)}`;
}

function formatFieldName(fieldName) {
    return fieldName
        .split('_')
        .map(word => word.charAt(0).toUpperCase() + word.slice(1).toLowerCase())
        .join(' ');
}

function processValue(value, unit) {
    let baseUnit = unit.replace(/ x\d+/, '');

    if (unit.includes('x10000')) {
        return (Number(value) / 10000).toFixed(4) + ' ' + baseUnit;
    }
    if (unit.includes('x1000')) {
        return (Number(value) / 1000).toFixed(3) + ' ' + baseUnit;
    }
    if (unit.includes('x100')) {
        return (Number(value) / 100).toFixed(3) + ' ' + baseUnit;
    }
    return value + ' ' + baseUnit;
}

// Data Smoothing utilizing Simple Moving Average
function smoothData(data, windowSize = 3) {
    if (data.length <= windowSize) return data;

    const smoothed = [];
    for (let i = 0; i < data.length; i++) {
        if (i < windowSize - 1) {
            smoothed.push(data[i]);
            continue;
        }

        let sum = 0;
        let validPoints = 0;
        for (let j = 0; j < windowSize; j++) {
            if (data[i - j] !== null && data[i - j] !== undefined) {
                sum += data[i - j];
                validPoints++;
            }
        }

        smoothed.push(validPoints > 0 ? sum / validPoints : null);
    }
    return smoothed;
}

async function initDashboard() {
    try {
        // 1. Fetch Store Info
        const [nickname, owner, sensorCount, deployedBlock, description] = await client.readContract({
            address: FACTORY_ADDRESS,
            abi: FactoryABI,
            functionName: 'getStoreInfo',
            args: [FLOODBOY016_STORE]
        });

        document.getElementById('storeNickname').innerText = nickname;
        document.getElementById('storeDescription').innerText = description;
        document.getElementById('storeAddressText').innerText = truncateAddress(FLOODBOY016_STORE);
        document.getElementById('storeAddressLink').href = `${JIBCHAIN.blockExplorers.default.url}/address/${FLOODBOY016_STORE}`;

        const currentBlock = await client.getBlockNumber();
        lastBlockFetched = currentBlock;
        document.getElementById('currentBlock').innerText = `Current Block: ${currentBlock}`;

        const now = new Date();
        const formattedDate = `${now.toLocaleDateString()}, ${now.toLocaleTimeString()}`;
        document.getElementById('lastUpdated').innerText = `Last Updated: ${formattedDate}`;
        document.getElementById('footerUpdated').innerText = `Last Updated: ${formattedDate}`;

        document.getElementById('ownerLink').innerText = truncateAddress(owner);
        document.getElementById('ownerLink').href = `${JIBCHAIN.blockExplorers.default.url}/address/${owner}`;

        document.getElementById('blockLink').innerText = `#${deployedBlock}`;
        document.getElementById('blockLink').href = `${JIBCHAIN.blockExplorers.default.url}/block/${deployedBlock}`;

        document.getElementById('sensorCount').innerText = `Sensor Count: ${sensorCount} authorized sensor`;

        // 2. Fetch Field Configs & Latest Record
        fieldConfigsCache = await client.readContract({
            address: FLOODBOY016_STORE,
            abi: StoreABI,
            functionName: 'getAllFields'
        });

        const latestRecord = await client.readContract({
            address: FLOODBOY016_STORE,
            abi: StoreABI,
            functionName: 'getLatestRecord',
            args: [UNIVERSAL_SIGNER]
        });

        renderDataTable(fieldConfigsCache, latestRecord[1]);

        // 3. Fetch Historical Data (Last 24h)
        document.getElementById('chartLoading').classList.remove('hidden');
        const fromBlock = currentBlock - 28800n; // ~24h

        const events = await client.getContractEvents({
            address: FLOODBOY016_STORE,
            abi: StoreABI,
            eventName: 'RecordStored',
            fromBlock: fromBlock,
            toBlock: 'latest',
            args: { sensor: UNIVERSAL_SIGNER }
        });

        const waterDepthIdx = fieldConfigsCache.findIndex(f => f.name.toLowerCase().includes('water_depth') && !f.name.includes('min') && !f.name.includes('max'));
        const voltageIdx = fieldConfigsCache.findIndex(f => f.name.toLowerCase().includes('battery_voltage') && !f.name.includes('min') && !f.name.includes('max'));

        chartDataCache = events.map(ev => ({
            timestamp: Number(ev.args.timestamp) * 1000,
            waterDepth: waterDepthIdx >= 0 ? Number(ev.args.values[waterDepthIdx]) / 10000 : null,
            batteryVoltage: voltageIdx >= 0 ? Number(ev.args.values[voltageIdx]) / 100 : null
        })).sort((a, b) => a.timestamp - b.timestamp);

        document.getElementById('chartLoading').classList.add('hidden');

        if (chartDataCache.length === 0) {
            document.getElementById('chartNoData').classList.remove('hidden');
        } else {
            renderChart(getActiveViewMode());
        }

        // 4. Start Real-time Polling
        startPolling();

    } catch (error) {
        console.error("Error initializing dashboard", error);
        document.getElementById('dataTableBody').innerHTML = `<tr><td colspan="4" class="text-center" style="color:red">Error loading data. See console.</td></tr>`;
        document.getElementById('chartLoading').innerText = "Error loading historical data";
    }
}

function getActiveViewMode() {
    const activeBtn = document.querySelector('.toggle-btn.active');
    return activeBtn ? activeBtn.getAttribute('data-view') : 'waterDepth';
}

async function startPolling() {
    if (pollingInterval) clearInterval(pollingInterval);

    pollingInterval = setInterval(async () => {
        try {
            const currentBlock = await client.getBlockNumber();
            if (currentBlock > lastBlockFetched) {
                console.log(`New blocks found: ${lastBlockFetched + 1n} to ${currentBlock}`);

                // Update UI Block Number
                document.getElementById('currentBlock').innerText = `Current Block: ${currentBlock}`;

                // Fetch new events
                const newEvents = await client.getContractEvents({
                    address: FLOODBOY016_STORE,
                    abi: StoreABI,
                    eventName: 'RecordStored',
                    fromBlock: lastBlockFetched + 1n,
                    toBlock: currentBlock,
                    args: { sensor: UNIVERSAL_SIGNER }
                });

                if (newEvents.length > 0) {
                    const waterDepthIdx = fieldConfigsCache.findIndex(f => f.name.toLowerCase().includes('water_depth') && !f.name.includes('min') && !f.name.includes('max'));
                    const voltageIdx = fieldConfigsCache.findIndex(f => f.name.toLowerCase().includes('battery_voltage') && !f.name.includes('min') && !f.name.includes('max'));

                    const newData = newEvents.map(ev => ({
                        timestamp: Number(ev.args.timestamp) * 1000,
                        waterDepth: waterDepthIdx >= 0 ? Number(ev.args.values[waterDepthIdx]) / 10000 : null,
                        batteryVoltage: voltageIdx >= 0 ? Number(ev.args.values[voltageIdx]) / 100 : null
                    }));

                    chartDataCache = [...chartDataCache, ...newData].sort((a, b) => a.timestamp - b.timestamp);

                    // Limit cache to last 200 points for performance
                    if (chartDataCache.length > 200) chartDataCache = chartDataCache.slice(-200);

                    // Update Data Table with latest record from events
                    const latestEvent = newEvents[newEvents.length - 1];
                    renderDataTable(fieldConfigsCache, latestEvent.args.values);

                    // Update Last Updated Timestamp
                    const now = new Date();
                    const formattedTime = now.toLocaleTimeString();
                    const formattedDate = now.toLocaleDateString();
                    document.getElementById('lastUpdated').innerText = `Last Updated: ${formattedTime}`;
                    document.getElementById('footerUpdated').innerText = `Last Updated: ${formattedDate}, ${formattedTime}`;

                    // Re-render chart
                    document.getElementById('chartNoData').classList.add('hidden');
                    renderChart(getActiveViewMode());
                }

                lastBlockFetched = currentBlock;
            }
        } catch (err) {
            console.warn("Polling error:", err);
        }
    }, 10000); // Poll every 10 seconds
}

function renderDataTable(fields, values) {
    const tbody = document.getElementById('dataTableBody');
    tbody.innerHTML = '';

    const metricGroups = {};

    fields.forEach((field, i) => {
        let baseName = field.name.replace(/_(min|max|count)$/i, '');
        if (!metricGroups[baseName]) {
            metricGroups[baseName] = {
                name: baseName,
                current: null, min: null, max: null, count: null,
                unit: field.unit
            };
        }

        if (field.name.endsWith('_min')) metricGroups[baseName].min = values[i];
        else if (field.name.endsWith('_max')) metricGroups[baseName].max = values[i];
        else if (field.name.endsWith('_count')) metricGroups[baseName].count = values[i];
        else metricGroups[baseName].current = values[i];
    });

    Object.values(metricGroups).forEach(group => {
        let displayName = formatFieldName(group.name);
        if (group.count !== null && group.count !== undefined) {
            displayName += ` (${group.count} samples)`;
        }

        const tr = document.createElement('tr');
        tr.innerHTML = `
            <td><strong>${displayName}</strong></td>
            <td>${group.current !== null ? processValue(group.current, group.unit) : '-'}</td>
            <td>${group.min !== null ? processValue(group.min, group.unit) : '-'}</td>
            <td>${group.max !== null ? processValue(group.max, group.unit) : '-'}</td>
        `;
        tbody.appendChild(tr);
    });
}

function renderChart(viewMode) {
    if (currentChart) {
        currentChart.destroy();
    }

    const labels = chartDataCache.map(d => {
        const date = new Date(d.timestamp);
        return `${date.getHours().toString().padStart(2, '0')}:${date.getMinutes().toString().padStart(2, '0')}`;
    });

    let rawData = [];
    let label = '';
    let color = '';

    if (viewMode === 'waterDepth') {
        rawData = chartDataCache.map(d => d.waterDepth);
        label = 'Water Depth (m)';
        color = '#3B82F6';
    } else {
        rawData = chartDataCache.map(d => d.batteryVoltage);
        label = 'Battery Voltage (V)';
        color = '#10B981';
    }

    const smoothedDataSet = smoothData(rawData, 3);

    const ctx = document.getElementById('sensorChart').getContext('2d');
    currentChart = new Chart(ctx, {
        type: 'line',
        data: {
            labels: labels,
            datasets: [{
                label: label,
                data: smoothedDataSet,
                borderColor: color,
                backgroundColor: color + '33',
                borderWidth: 2,
                pointRadius: 2,
                fill: true,
                tension: 0.4
            }]
        },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            plugins: {
                legend: { display: false },
                tooltip: {
                    callbacks: {
                        label: function (context) {
                            return `${context.parsed.y.toFixed(viewMode === 'waterDepth' ? 4 : 3)} ${viewMode === 'waterDepth' ? 'm' : 'V'}`;
                        }
                    }
                }
            },
            scales: {
                y: {
                    beginAtZero: false
                },
                x: {
                    grid: { display: false }
                }
            }
        }
    });

    document.getElementById('chartTitle').innerText = `${viewMode === 'waterDepth' ? 'Water Depth' : 'Battery Voltage'} Over Time`;
}

// Event Listeners for Toggles
document.getElementById('btnWaterDepth').addEventListener('click', (e) => {
    document.querySelectorAll('.toggle-btn').forEach(btn => btn.classList.remove('active'));
    e.target.classList.add('active');
    renderChart('waterDepth');
});

document.getElementById('btnBatteryVoltage').addEventListener('click', (e) => {
    document.querySelectorAll('.toggle-btn').forEach(btn => btn.classList.remove('active'));
    e.target.classList.add('active');
    renderChart('batteryVoltage');
});

// Start the application
initDashboard();

