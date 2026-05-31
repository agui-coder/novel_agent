import { invokeApi } from './client';

export type RuntimeConfigGroup = string;

export interface RuntimeConfigItem {
    key: string;
    group: RuntimeConfigGroup;
    label: string;
    secret: boolean;
    configured: boolean;
    source: string;
    source_key: string;
    value?: string;
    masked_value?: string;
    suffix?: string;
    options?: { label: string; value: string }[];
}

export interface RuntimeConfigGroupSummary {
    group: RuntimeConfigGroup;
    configured: number;
    total: number;
    missing_keys: string[];
}

export interface RuntimeConfigResponse {
    status: 'success';
    items: RuntimeConfigItem[];
    groups: RuntimeConfigGroupSummary[];
    saved_keys?: string[];
    env_file_exists?: boolean;
}

export interface RuntimeConfigCheckResponse {
    status: 'success';
    ready: boolean;
    missing_required_keys: string[];
}

const PROVIDERS: Record<string, { base: string; models: string[] }> = {
    deepseek: { base: 'https://api.deepseek.com/v1', models: ['deepseek-v4-flash', 'deepseek-reasoner'] },
    openai: { base: 'https://api.openai.com/v1', models: ['gpt-4o', 'gpt-4o-mini', 'gpt-4-turbo'] },
    custom: { base: '', models: [] },
};

export async function fetchRuntimeConfig(): Promise<RuntimeConfigResponse> {
    const config = await invokeApi<Record<string, any>>('get_config');
    const apiKey = (config.api_key as string) || '';
    const model = (config.model as string) || 'deepseek-chat';
    const baseUrl = (config.api_base_url as string) || PROVIDERS.deepseek.base;
    const provider = (config.provider as string) || 'deepseek';
    const presets = PROVIDERS[provider] || PROVIDERS.custom;

    return {
        status: 'success',
        items: [
            {
                key: 'provider', group: 'llm', label: '模型提供商', secret: false,
                configured: true, source: provider ? 'local' : 'default', source_key: 'provider',
                value: provider,
                options: [
                    { label: 'DeepSeek', value: 'deepseek' },
                    { label: 'OpenAI', value: 'openai' },
                    { label: '自定义', value: 'custom' },
                ],
            },
            {
                key: 'api_key', group: 'llm', label: 'API Key', secret: true,
                configured: !!apiKey, source: apiKey ? 'local' : 'missing', source_key: 'api_key',
                suffix: apiKey ? apiKey.slice(-4) : '',
            },
            {
                key: 'model', group: 'llm', label: '模型', secret: false,
                configured: !!model, source: model ? 'local' : 'default', source_key: 'model',
                value: model,
            },
            {
                key: 'api_base_url', group: 'llm', label: 'API 地址', secret: false,
                configured: true, source: baseUrl ? 'local' : 'default', source_key: 'api_base_url',
                value: baseUrl || presets.base,
            },
        ],
        groups: [
            {
                group: 'llm', configured: apiKey ? 4 : 3, total: 4,
                missing_keys: apiKey ? [] : ['api_key'],
            },
        ],
    };
}

export async function saveRuntimeConfig(values: Record<string, string>): Promise<RuntimeConfigResponse> {
    // When provider changes, auto-fill base_url and suggest model
    if (values.provider && values.provider !== 'custom') {
        const preset = PROVIDERS[values.provider];
        if (preset && !values.api_base_url) {
            values.api_base_url = preset.base;
        }
        if (preset && !values.model) {
            values.model = preset.models[0] || '';
        }
    }
    await invokeApi('save_config', { values });
    const result = await fetchRuntimeConfig();
    result.saved_keys = Object.keys(values);
    return result;
}

export async function checkRuntimeConfig(): Promise<RuntimeConfigCheckResponse> {
    const config = await invokeApi<Record<string, any>>('get_config');
    const apiKey = (config.api_key as string) || '';
    return {
        status: 'success',
        ready: !!apiKey,
        missing_required_keys: apiKey ? [] : ['api_key'],
    };
}
