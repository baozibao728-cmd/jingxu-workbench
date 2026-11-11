import {readConfig} from './config.js';
import {ProviderSettings} from './provider-settings.js';
import {fileURLToPath} from 'node:url';
const saved=new ProviderSettings(fileURLToPath(new URL('../data/projects/provider-settings.json',import.meta.url)),readConfig());await saved.init();
// Only local status; never print credentials or contact generation services.
for(const [name,config] of Object.entries(saved.config()))console.log(`${name}: ${config.baseUrl}; Key=${config.apiKey?'已填写':'待填写'}; 模型=${config.model||'待选择'}; 协议=${config.protocol}`);
