import axios from 'axios';

const API_BASE = import.meta.env.VITE_API_BASE_URL || (import.meta.env.DEV ? 'http://localhost:4000/api' : '/api');

export const api = axios.create({ baseURL: API_BASE, timeout: 12000 });

export function getPlayerStats(wallet: string) {
  return api.get('/player/stats', { params: { wallet } });
}

export function fetchDailyMissions() {
  return api.get('/quests/daily');
}

export function fetchNPCDialogue(type: string, player: string) {
  return api.get('/npc/dialogue', { params: { type, player } });
}

export function generateQuest(wallet: string) {
  return api.post('/quests/generate', { wallet });
}

export function validateQuest(wallet: string, questId: string, proofUri: string) {
  return api.post('/quests/validate', { wallet, questId, proofUri });
}
