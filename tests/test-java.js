import { braceLanguages } from './packages/icr-merge/lang-brace.js';
const lang = braceLanguages.find(l => l.id === 'c');

const src = `package com.hft.core;

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

    // --- ARCHITECT: KAFKA INTEGRATION ---
    @KafkaListener(topics = "high-frequency-trades", groupId = "hft-group")
    public void consumeTradeStream(String message) {
        System.out.println("Consumed: " + message);
        verifySecurityToken(message);
    }
    
    private void verifySecurityToken(String msg) {
        // RSA verification logic
    }
    // --- FEATURE: GRACEFUL SHUTDOWN & JMX ---
    @PreDestroy
    public void onShutdown() {
        System.out.println("Draining inflight transactions...");
        System.out.println("Releasing distributed locks...");
    }
    
    public String getHealthMetrics() {
        return "{\\"status\\":\\"healthy\\", \\"tps\\": 15420}";
    }
}`;

console.log('Parses:', lang.parsesUnit(src));
