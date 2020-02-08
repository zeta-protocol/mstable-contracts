pragma solidity ^0.5.12;
pragma experimental ABIEncoderV2;

import { MassetStructs } from "../shared/MassetStructs.sol";

/**
  * @title IForgeValidator
  * @dev Abstract ForgeValidator contract for interacting with the Forge Library
  */
contract IForgeValidator is MassetStructs {
    function validateMint(uint256 _totalVault, Basset memory _basset, uint256 _bassetQuantity) public pure;
    function validateMint(uint256 _totalVault, Basset[] memory _bassets, uint256[] memory _bassetQuantity) public pure;
    function validateRedemption(bool isBasketFailed, Basset[] memory _bassets, uint256[] memory _bassetQuantity) public pure;
}