// src/chat/presence.service.ts
import { Injectable } from '@nestjs/common';

import { AgentPresence } from './interfaces/agent-presence.interface';

@Injectable()
export class PresenceService {
  private readonly agentSocketMap = new Map<string, AgentPresence>();

  addAgent(socketId: string, agent: AgentPresence): void {
    this.agentSocketMap.set(socketId, agent);
    console.log(`✅ Agente conectado: ${agent.firstName || agent.email} con socket: ${socketId}. Total: ${this.agentSocketMap.size}`);
  }

  removeAgent(socketId: string): void {
    if (this.agentSocketMap.has(socketId)) {
      const agent = this.agentSocketMap.get(socketId);
      this.agentSocketMap.delete(socketId);
      console.log(`❌ Agente desconectado: ${agent.firstName || agent.email}. Total: ${this.agentSocketMap.size}`);
    }
  }
  
  getConnectedAgents(): AgentPresence[] {
    return Array.from(this.agentSocketMap.values());
  }

  /**
   * ✅ FUNCIÓN AÑADIDA
   * Busca en el mapa de sockets y devuelve el socketId para un agentId específico.
   */
  getSocketIdForAgent(agentId: number): string | undefined {
    for (const [socketId, agent] of this.agentSocketMap.entries()) {
      if (agent.id === agentId) {
        return socketId;
      }
    }
    return undefined;
  }
}