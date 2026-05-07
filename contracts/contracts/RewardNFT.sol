// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import '@openzeppelin/contracts/token/ERC721/ERC721.sol';
import '@openzeppelin/contracts/access/Ownable.sol';
import '@openzeppelin/contracts/security/Pausable.sol';

contract RewardNFT is ERC721, Ownable, Pausable {
    uint256 public nextTokenId;
    mapping(uint256 => string) public tokenURIs;
    mapping(uint256 => uint256) public questHistory;

    event RewardMinted(address indexed player, uint256 indexed tokenId, uint256 questId);

    constructor() ERC721('QuestForge Achievement', 'QFAI') {
        nextTokenId = 1;
    }

    function mintQuestReward(address player, uint256 questId, string memory metadataUri) external whenNotPaused {
        require(player != address(0), 'Invalid player');
        uint256 tokenId = nextTokenId++;
        _safeMint(player, tokenId);
        tokenURIs[tokenId] = metadataUri;
        questHistory[tokenId] = questId;
        emit RewardMinted(player, tokenId, questId);
    }

    function tokenURI(uint256 tokenId) public view override returns (string memory) {
        require(_exists(tokenId), 'URI query for nonexistent token');
        return tokenURIs[tokenId];
    }

    function pause() external onlyOwner {
        _pause();
    }

    function unpause() external onlyOwner {
        _unpause();
    }
}
