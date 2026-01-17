// presence.service.ts
import { Injectable, Logger } from '@nestjs/common';
import { AgentPresence } from './interfaces/agent-presence.interface';

@Injectable()
export class PresenceService {
  private readonly logger = new Logger(PresenceService.name);
  private readonly agentSocketMap = new Map<string, AgentPresence>();

  addAgent(socketId: string, agent: AgentPresence): void {
    this.agentSocketMap.set(socketId, agent);
    this.logger.log(`[PRESENCE] Agente conectado: ${agent.firstName || agent.email} con socket: ${socketId}. Total: ${this.agentSocketMap.size}`);
  }

  removeAgent(socketId: string): void {
    if (this.agentSocketMap.has(socketId)) {
      const agent = this.agentSocketMap.get(socketId);
      this.agentSocketMap.delete(socketId);
      this.logger.log(`[PRESENCE] Agente desconectado: ${agent.firstName || agent.email}. Total: ${this.agentSocketMap.size}`);
    }
  }
  
  getConnectedAgents(): AgentPresence[] {
    return Array.from(this.agentSocketMap.values());
  }

  getSocketIdForAgent(agentId: number): string | undefined {
    for (const [socketId, agent] of this.agentSocketMap.entries()) {
      if (agent.id === agentId) {
        return socketId;
      }
    }
    return undefined;
  }
}