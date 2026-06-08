import { Request, Response } from 'express';

export async function getNFTMetadata(req: Request, res: Response) {
  const tokenId = req.query.tokenId?.toString() || '0';
  const metadata = {
    name: `Online ForgeQuest Game Achievement #${tokenId}`,
    description: 'A legendary NFT minted for completing a Forge Quest on the Celo blockchain.',
    image: 'https://assets.questforge.ai/nft-glow.png',
    attributes: [
      { trait_type: 'Rarity', value: 'Legendary' },
      { trait_type: 'XP Earned', value: 1250 },
      { trait_type: 'Series', value: 'Online ForgeQuest Game' }
    ]
  };
  res.json(metadata);
}
