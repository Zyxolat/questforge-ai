// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/token/ERC721/extensions/ERC721URIStorage.sol";
import "@openzeppelin/contracts/access/AccessControl.sol";

contract RewardNFT is ERC721URIStorage, AccessControl {
    bytes32 public constant MINTER_ROLE = keccak256("MINTER_ROLE");
    uint256 public constant MAX_METADATA_URI_LENGTH = 2048;
    uint256 private _tokenIds;
    mapping(uint256 => uint256) public questHistory;
    mapping(uint256 => bool) public mintedQuestIds;

    event RewardMinted(address indexed player, uint256 indexed tokenId, uint256 questId);

    constructor(address admin) ERC721("ForgeQuest Reward", "QFR") {
        _grantRole(DEFAULT_ADMIN_ROLE, admin);
        _grantRole(MINTER_ROLE, admin);
    }

    function mintQuestReward(
        address player,
        uint256 questId,
        string memory metadataUri
    ) external onlyRole(MINTER_ROLE) returns (uint256) {
        require(player != address(0), "Invalid player");
        require(bytes(metadataUri).length > 0, "Metadata required");
        require(bytes(metadataUri).length <= MAX_METADATA_URI_LENGTH, "Metadata too long");
        require(!mintedQuestIds[questId], "Quest reward already minted");

        _tokenIds++;
        uint256 newTokenId = _tokenIds;
        _safeMint(player, newTokenId);
        _setTokenURI(newTokenId, metadataUri);
        questHistory[newTokenId] = questId;
        mintedQuestIds[questId] = true;
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
