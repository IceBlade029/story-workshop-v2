/**
 * asset-tools.ts — 设定读取工具（chat/organize 白名单）。
 * 只读。设定对 chat/organize 开放（角色一致性检查是设定的头号用途）。
 */
import type { ToolSpec } from '../tool-types';
import { AssetRepository } from '../../storage/asset-repository';
import { sha256 } from '../../storage/hash';
import { ok, fail, assetEvidence } from './tool-utils';

export function makeAssetReadTools(projectDir: () => string): ToolSpec[] {
  const assets = () => new AssetRepository(projectDir());

  return [
    {
      name: 'list_assets',
      description: '列出全部设定（id、类型、标题、hash、时间戳），不含正文。可传 type 过滤（character|worldbuilding|timeline|location|prop|foreshadow|misc 或任意自定义）。',
      inputSchema: {
        type: 'object',
        properties: {
          type: { type: 'string', description: '按类型过滤，可选' },
        },
      } as never,
      outputSchema: {} as never,
      async execute(_ctx, args: { type?: string }) {
        const list = assets().listAssets().filter((a) => !args.type || a.type === args.type);
        return ok(
          {
            assets: list.map((a) => ({
              id: a.id,
              type: a.type,
              title: a.title,
              hash: a.hash,
              createdAt: a.createdAt,
              updatedAt: a.updatedAt,
            })),
          },
          list.map((a) => assetEvidence(a.id, a.hash)),
        );
      },
    },

    {
      name: 'read_asset',
      description: '读取单个设定的完整内容（markdown 自由格式）。',
      inputSchema: {
        type: 'object',
        properties: {
          assetId: { type: 'string', description: '设定 id' },
        },
        required: ['assetId'],
      } as never,
      outputSchema: {} as never,
      async execute(_ctx, args: { assetId: string }) {
        const asset = assets().readAsset(args.assetId);
        if (!asset) return fail('ASSET_NOT_FOUND', `设定不存在: ${args.assetId}`);
        return ok(
          {
            id: asset.id,
            type: asset.type,
            title: asset.title,
            content: asset.content,
            hash: sha256(asset.content),
            updatedAt: asset.updatedAt,
          },
          [assetEvidence(asset.id, sha256(asset.content), asset.content.slice(0, 200))],
        );
      },
    },
  ];
}
