// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/token/ERC721/extensions/ERC721URIStorage.sol";
import "@openzeppelin/contracts/access/AccessControl.sol";

contract RewardNFT is ERC721URIStorage, AccessControl {
    bytes32 public constant MINTER_ROLE = keccak256("MINTER_ROLE");
    uint256 private _tokenIds;
    mapping(uint256 => uint256) public questHistory;

    event RewardMinted(address indexed player, uint256 indexed tokenId, uint256 questId);

    constructor(address admin) ERC721("QuestForge Reward", "QFR") {
        _grantRole(DEFAULT_ADMIN_ROLE, admin);
        _grantRole(MINTER_ROLE, admin);
    }

    function mintQuestReward(
        address player,
        uint256 questId,
        string memory metadataUri
    ) external onlyRole(MINTER_ROLE) returns (uint256) {
        _tokenIds++;
        uint256 newTokenId = _tokenIds;
        _safeMint(player, newTokenId);
        _setTokenURI(newTokenId, metadataUri);
        questHistory[newTokenId] = questId;
        emit RewardMinted(player, newTokenId, questId);
        return newTokenId;
    }

    function supportsInterface(bytes4 interfaceId)
        public
        view
        override(ERC721URIStorage, AccessControl)
        returns (bool)
    {
        return super.supportsInterface(interfaceId);
    }
}
