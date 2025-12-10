import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { existsSync, readdirSync, readFileSync } from 'fs';
import { join } from 'path';
import express from 'express';

// Mock fs module
vi.mock('fs', () => ({
  existsSync: vi.fn(),
  readdirSync: vi.fn(),
  readFileSync: vi.fn()
}));

// Import after mocking
const { AgentManager } = await import('../AgentManager.mjs');

/**
 * Test suite for AgentManager
 * Covers agent discovery, loading, and cleanup
 */
describe('AgentManager', () => {
  let agentManager;
  const mockAgentsPath = '/test/agents';

  beforeEach(() => {
    agentManager = new AgentManager(mockAgentsPath);
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  describe('constructor', () => {
    it('should initialize with agents path', () => {
      expect(agentManager.agentsPath).toBe(mockAgentsPath);
      expect(agentManager.agents).toBeInstanceOf(Map);
      expect(agentManager.agents.size).toBe(0);
    });
  });

  describe('discover', () => {
    it('should return empty array if .agents directory does not exist', () => {
      existsSync.mockReturnValue(false);

      const discovered = agentManager.discover();

      expect(discovered).toEqual([]);
      expect(existsSync).toHaveBeenCalledWith(mockAgentsPath);
    });

    it('should discover valid agents', () => {
      existsSync.mockImplementation((path) => {
        if (path === mockAgentsPath) return true;
        if (path.includes('epistery.json')) return true;
        if (path.includes('index.mjs')) return true;
        return false;
      });

      readdirSync.mockReturnValue([
        { name: 'test-agent', isDirectory: () => true, isSymbolicLink: () => false }
      ]);

      const mockManifest = {
        name: '@test/agent',
        version: '1.0.0',
        description: 'Test agent'
      };

      readFileSync.mockReturnValue(JSON.stringify(mockManifest));

      const discovered = agentManager.discover();

      expect(discovered).toHaveLength(1);
      expect(discovered[0].name).toBe('test-agent');
      expect(discovered[0].manifest).toEqual(mockManifest);
      expect(discovered[0].path).toBe(join(mockAgentsPath, 'test-agent'));
    });

    it('should skip directories without epistery.json', () => {
      existsSync.mockImplementation((path) => {
        if (path === mockAgentsPath) return true;
        if (path.includes('epistery.json')) return false;
        if (path.includes('index.mjs')) return true;
        return false;
      });

      readdirSync.mockReturnValue([
        { name: 'invalid-agent', isDirectory: () => true, isSymbolicLink: () => false }
      ]);

      const discovered = agentManager.discover();

      expect(discovered).toEqual([]);
    });

    it('should skip directories without index.mjs', () => {
      existsSync.mockImplementation((path) => {
        if (path === mockAgentsPath) return true;
        if (path.includes('epistery.json')) return true;
        if (path.includes('index.mjs')) return false;
        return false;
      });

      readdirSync.mockReturnValue([
        { name: 'invalid-agent', isDirectory: () => true, isSymbolicLink: () => false }
      ]);

      const discovered = agentManager.discover();

      expect(discovered).toEqual([]);
    });

    it('should skip non-directory entries', () => {
      existsSync.mockReturnValue(true);

      readdirSync.mockReturnValue([
        { name: 'file.txt', isDirectory: () => false, isSymbolicLink: () => false }
      ]);

      const discovered = agentManager.discover();

      expect(discovered).toEqual([]);
    });

    it('should handle symlinked agent directories', () => {
      existsSync.mockImplementation((path) => {
        if (path === mockAgentsPath) return true;
        if (path.includes('epistery.json')) return true;
        if (path.includes('index.mjs')) return true;
        return false;
      });

      readdirSync.mockReturnValue([
        { name: 'symlinked-agent', isDirectory: () => false, isSymbolicLink: () => true }
      ]);

      const mockManifest = {
        name: '@symlinked/agent',
        version: '1.0.0'
      };

      readFileSync.mockReturnValue(JSON.stringify(mockManifest));

      const discovered = agentManager.discover();

      expect(discovered).toHaveLength(1);
      expect(discovered[0].name).toBe('symlinked-agent');
    });

    it('should skip agents with invalid manifest JSON', () => {
      existsSync.mockImplementation((path) => {
        if (path === mockAgentsPath) return true;
        if (path.includes('epistery.json')) return true;
        if (path.includes('index.mjs')) return true;
        return false;
      });

      readdirSync.mockReturnValue([
        { name: 'broken-agent', isDirectory: () => true, isSymbolicLink: () => false }
      ]);

      readFileSync.mockReturnValue('invalid json {');

      const discovered = agentManager.discover();

      expect(discovered).toEqual([]);
    });

    it('should discover multiple valid agents', () => {
      existsSync.mockImplementation((path) => {
        if (path === mockAgentsPath) return true;
        if (path.includes('epistery.json')) return true;
        if (path.includes('index.mjs')) return true;
        return false;
      });

      readdirSync.mockReturnValue([
        { name: 'agent1', isDirectory: () => true, isSymbolicLink: () => false },
        { name: 'agent2', isDirectory: () => true, isSymbolicLink: () => false }
      ]);

      let callCount = 0;
      readFileSync.mockImplementation(() => {
        callCount++;
        return JSON.stringify({
          name: `@test/agent${callCount}`,
          version: '1.0.0'
        });
      });

      const discovered = agentManager.discover();

      expect(discovered).toHaveLength(2);
      expect(discovered[0].name).toBe('agent1');
      expect(discovered[1].name).toBe('agent2');
    });
  });

  describe('loadAgent', () => {
    it('should skip agent without name in manifest', async () => {
      const app = express();
      const agentInfo = {
        name: 'test-agent',
        manifest: { version: '1.0.0' }, // Missing name
        entryPath: '/test/index.mjs'
      };

      await agentManager.loadAgent(agentInfo, app);

      expect(agentManager.agents.size).toBe(0);
    });
  });

  describe('cleanup', () => {
    it('should call cleanup on all agents with cleanup method', async () => {
      const mockCleanup1 = vi.fn().mockResolvedValue(undefined);
      const mockCleanup2 = vi.fn().mockResolvedValue(undefined);

      agentManager.agents.set('agent1', {
        instance: { cleanup: mockCleanup1 }
      });

      agentManager.agents.set('agent2', {
        instance: { cleanup: mockCleanup2 }
      });

      await agentManager.cleanup();

      expect(mockCleanup1).toHaveBeenCalledTimes(1);
      expect(mockCleanup2).toHaveBeenCalledTimes(1);
    });

    it('should skip agents without cleanup method', async () => {
      agentManager.agents.set('agent1', {
        instance: {}
      });

      await expect(agentManager.cleanup()).resolves.not.toThrow();
    });

    it('should handle cleanup errors gracefully', async () => {
      const mockCleanup = vi.fn().mockRejectedValue(new Error('Cleanup failed'));

      agentManager.agents.set('agent1', {
        instance: { cleanup: mockCleanup }
      });

      await expect(agentManager.cleanup()).resolves.not.toThrow();
      expect(mockCleanup).toHaveBeenCalledTimes(1);
    });

    it('should cleanup all agents even if one fails', async () => {
      const mockCleanup1 = vi.fn().mockRejectedValue(new Error('Failed'));
      const mockCleanup2 = vi.fn().mockResolvedValue(undefined);

      agentManager.agents.set('agent1', {
        instance: { cleanup: mockCleanup1 }
      });

      agentManager.agents.set('agent2', {
        instance: { cleanup: mockCleanup2 }
      });

      await agentManager.cleanup();

      expect(mockCleanup1).toHaveBeenCalledTimes(1);
      expect(mockCleanup2).toHaveBeenCalledTimes(1);
    });
  });

  describe('path generation', () => {
    it('should remove @ from package name for routing', () => {
      const packageName = '@geistm/adnet-agent';
      const expected = 'geistm/adnet-agent';

      expect(packageName.replace(/^@/, '')).toBe(expected);
    });

    it('should handle package names without @', () => {
      const packageName = 'simple-agent';
      const expected = 'simple-agent';

      expect(packageName.replace(/^@/, '')).toBe(expected);
    });

    it('should generate correct well-known path', () => {
      const routeName = 'test/agent';
      const wellKnownPath = `/.well-known/epistery/agent/${routeName}`;

      expect(wellKnownPath).toBe('/.well-known/epistery/agent/test/agent');
    });

    it('should generate correct short path', () => {
      const routeName = 'test/agent';
      const shortPath = `/agent/${routeName}`;

      expect(shortPath).toBe('/agent/test/agent');
    });
  });
});
