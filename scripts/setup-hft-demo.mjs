import fs from 'fs';
import { execSync } from 'child_process';
import path from 'path';

const DIR = 'demo-recording-hft/repo';

function run(cmd) {
  console.log(`\n> ${cmd}`);
  try {
    const out = execSync(cmd, { cwd: DIR, encoding: 'utf8', stdio: 'pipe' });
    if (out.trim()) console.log(out.trim());
    return out;
  } catch (e) {
    console.log(e.stdout || '');
    console.log(e.stderr || '');
    throw e;
  }
}

if (fs.existsSync('demo-recording-hft')) {
  fs.rmSync('demo-recording-hft', { recursive: true, force: true });
}
fs.mkdirSync(DIR, { recursive: true });
run('git init');

const packageJson = {
  name: "demo-repo-hft",
  scripts: {
    "enable-icr": "git config merge.icr.name \"Intent-Centric Reconciliation\" && git config merge.icr.driver \"node ../../packages/icr-merge/bin/icr-merge-driver.js %O %A %B %P\" && git config merge.default icr && echo ICR Engine Enabled in Git!",
    "disable-icr": "git config --unset merge.icr.name & git config --unset merge.icr.driver & git config --unset merge.default & echo ICR Engine Disabled — using standard Git merge."
  }
};
fs.writeFileSync(path.join(DIR, 'package.json'), JSON.stringify(packageJson, null, 2) + '\n');
fs.writeFileSync(path.join(DIR, '.gitattributes'), '*.js merge=icr\n*.py merge=icr\n*.cpp merge=icr\n*.java merge=icr\n');
run('git add package.json .gitattributes');

// --- BASE CODE ---
const cppBase = `#include <iostream>
#include <mutex>
#include <memory>

class OrderMatchingEngine {
private:
    std::mutex order_mutex;
public:
    void execute_trade(const std::string& order_id, double amount) {
        std::lock_guard<std::mutex> lock(order_mutex);
        std::cout << "[ENGINE] Executing trade: " << order_id << " for $" << amount << std::endl;
        // High-frequency matching logic placeholder
        std::cout << "[ENGINE] Trade finalized." << std::endl;
    }
};`;

const jsBase = `import { useState, useEffect } from 'react';

// Core websocket connection for live market data
export async function processTradeSocketStream(connectionId) {
    console.log(\`Establishing secure WSS stream on port 443: \${connectionId}\`);
    return { status: "secure_connected", id: connectionId };
}

export function LiveMarketDashboard() {
    const [stream, setStream] = useState(null);

    useEffect(() => {
        processTradeSocketStream('init-001').then(setStream);
    }, []);

    return "Dashboard Active";
}`;

const pyBase = `import numpy as np
import pandas as pd
from typing import List, Dict
import random

class TradeAnalyticsPipeline:
    """
    Core AI Pipeline for analyzing high-frequency trade flow.
    """
    def __init__(self, data_stream: List[Dict]):
        self.data_stream = data_stream
        self.active = True

    def _normalize_tensor(self, matrix: np.ndarray) -> np.ndarray:
        return (matrix - np.min(matrix)) / (np.max(matrix) - np.min(matrix))

    def process_batch(self, batch_id: str):
        print(f"Processing batch {batch_id}")
        return True`;

const javaBase = `package com.hft.core;

import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

/**
 * Global Transaction Coordinator
 * Manages distributed two-phase commits across all microservices.
 */
@Service
public class GlobalTransactionCoordinator {
    
    public GlobalTransactionCoordinator() {
        System.out.println("Coordinator initialized.");
    }

    @Transactional
    public boolean commit(String transactionId) {
        return true;
    }

    public void rollback(String transactionId) {
        System.out.println("Rolling back: " + transactionId);
    }
}`;

const sqlBase = `CREATE TABLE portfolios (
    id UUID PRIMARY KEY,
    owner_id UUID NOT NULL,
    total_value DECIMAL(15, 2)
);

CREATE TABLE trade_executions (
    trade_id UUID PRIMARY KEY,
    portfolio_id UUID REFERENCES portfolios(id),
    status VARCHAR(20)
);`;

fs.writeFileSync(path.join(DIR, 'processor.cpp'), cppBase + '\n');
fs.writeFileSync(path.join(DIR, 'frontend.js'), jsBase + '\n');
fs.writeFileSync(path.join(DIR, 'backend.py'), pyBase + '\n');
fs.writeFileSync(path.join(DIR, 'enterprise.java'), javaBase + '\n');
fs.writeFileSync(path.join(DIR, 'schema.sql'), sqlBase + '\n');
run('git add .');
run('git commit -m "Base: Initial HFT architecture"');

// --- ARCHITECT BRANCH ---
run('git checkout -b architect');

const cppArch = cppBase.replace(
  'std::lock_guard<std::mutex> lock(order_mutex);',
  '// [ARCHITECT] Migrated to lock-free queue for sub-microsecond latency\n        // std::lock_guard<std::mutex> lock(order_mutex);'
).replace(
  'std::cout << "[ENGINE] Executing trade:',
  'std::cout << "[ENGINE] [LOCK-FREE] Executing trade:'
);

const jsArch = jsBase.replace(
  'export async function processTradeSocketStream',
  '// [ARCHITECT] Renamed to match new SOC2 naming conventions\nexport async function initializeSecureWebSocket'
).replace(
  "processTradeSocketStream('init-001')",
  "initializeSecureWebSocket('init-001')"
);

const pyArch = pyBase.replace(
  '        return True',
  `        return True

    def run_monte_carlo(self, iterations: int = 10000):
        \"\"\"
        Executes a stochastic volatility model.
        \"\"\"
        # ==========================================
        # ARCHITECT: MONTE CARLO SIMULATION ENGINE
        # ==========================================
        results = []
        for i in range(iterations):
            path = np.random.normal(0, 1, 252)
            results.append(path)
        return pd.DataFrame(results)

    def calculate_var(self, confidence_level: float = 0.99):
        print(f"Calculating Value at Risk for {confidence_level}")
        return 0.05`
);

const javaArch = javaBase.replace(
  '    public void rollback(String transactionId) {',
  `    // --- ARCHITECT: KAFKA INTEGRATION ---\n    @KafkaListener(topics = "high-frequency-trades", groupId = "hft-group")\n    public void consumeTradeStream(String message) {\n        System.out.println("Consumed: " + message);\n        verifySecurityToken(message);\n    }\n    \n    private void verifySecurityToken(String msg) {\n        // RSA verification logic\n    }\n\n    public void rollback(String transactionId) {`
);

const sqlArch = sqlBase + `\n\nCREATE INDEX idx_trade_status ON trade_executions(status);`;

fs.writeFileSync(path.join(DIR, 'processor.cpp'), cppArch + '\n');
fs.writeFileSync(path.join(DIR, 'frontend.js'), jsArch + '\n');
fs.writeFileSync(path.join(DIR, 'backend.py'), pyArch + '\n');
fs.writeFileSync(path.join(DIR, 'enterprise.java'), javaArch + '\n');
fs.writeFileSync(path.join(DIR, 'schema.sql'), sqlArch + '\n');
run('git commit -am "Architect: Lock-free engine, WSS security, Monte Carlo, Kafka integration, DB indices"');

// --- FEATURE BRANCH ---
run('git checkout master');

const cppFeat = cppBase.replace(
  '// High-frequency matching logic placeholder',
  '// High-frequency matching logic placeholder\n        \n        // [FEATURE] Mandatory SEC Compliance Auditing\n        std::cout << "[AUDIT] SEC Form 4 filed for trade " << order_id << std::endl;'
);

const jsFeat = jsBase.replace(
  '    return "Dashboard Active";\n}',
  `    
    // [FEATURE] Added multiple new telemetry hooks calling the core stream
    useEffect(() => {
        processTradeSocketStream('telemetry-002').then(data => console.log(data));
        processTradeSocketStream('risk-003').then(data => console.log(data));
        processTradeSocketStream('audit-004').then(data => console.log(data));
    }, []);

    return "Dashboard Active";
}`
);

const pyFeat = pyBase.replace(
  '    def process_batch(self, batch_id: str):',
  `    @staticmethod
    def detect_wash_trading(trades: pd.DataFrame) -> bool:
        \"\"\"
        Uses DBSCAN clustering to identify wash trading rings.
        \"\"\"
        # ==========================================
        # FEATURE: ML FRAUD DETECTION ENGINE
        # ==========================================
        print("Running unsupervised anomaly detection...")
        return random.choice([True, False])

    def alert_compliance(self, trade_id: str):
        print(f"CRITICAL: Wash trade detected on {trade_id}. Alerting SEC.")

    def process_batch(self, batch_id: str):`
);

const javaFeat = javaBase.replace(
  '    public void rollback(String transactionId) {\n        System.out.println("Rolling back: " + transactionId);\n    }\n}',
  `    public void rollback(String transactionId) {\n        System.out.println("Rolling back: " + transactionId);\n    }\n\n    // --- FEATURE: GRACEFUL SHUTDOWN & JMX ---\n    @PreDestroy\n    public void onShutdown() {\n        System.out.println("Draining inflight transactions...");\n        System.out.println("Releasing distributed locks...");\n    }\n    \n    public String getHealthMetrics() {\n        return "{\\"status\\":\\"healthy\\", \\"tps\\": 15420}";\n    }\n}`
);

const sqlFeat = sqlBase.replace(
  'total_value DECIMAL(15, 2)\n);',
  'total_value DECIMAL(15, 2),\n    margin_call_threshold DECIMAL(15, 2)\n);'
);

fs.writeFileSync(path.join(DIR, 'processor.cpp'), cppFeat + '\n');
fs.writeFileSync(path.join(DIR, 'frontend.js'), jsFeat + '\n');
fs.writeFileSync(path.join(DIR, 'backend.py'), pyFeat + '\n');
fs.writeFileSync(path.join(DIR, 'enterprise.java'), javaFeat + '\n');
fs.writeFileSync(path.join(DIR, 'schema.sql'), sqlFeat + '\n');
run('git commit -am "Feature: SEC auditing, telemetry dashboard hooks, Wash Trading ML, graceful shutdown, margin thresholds"');

console.log('\n======================================================');
console.log('✅ HFT ENTERPRISE ENVIRONMENT READY');
console.log('Navigate to demo-recording-hft/repo to start.');
console.log('======================================================\n');
