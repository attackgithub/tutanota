// @flow
import m from "mithril"
import {assertMainOrNode} from "../api/Env"
import {worker} from "../api/main/WorkerClient"
import {TextField} from "../gui/base/TextField"
import {ButtonType} from "../gui/base/ButtonN"
import {Dialog, DialogType} from "../gui/base/Dialog"
import {lang} from "../misc/LanguageViewModel"
import type {BookingItemFeatureTypeEnum} from "../api/common/TutanotaConstants"
import {AccountType, BookingItemFeatureType, FeatureType} from "../api/common/TutanotaConstants"
import {neverNull} from "../api/common/utils/Utils"
import {formatDate} from "../misc/Formatter"
import {load} from "../api/main/Entity"
import {CustomerTypeRef} from "../api/entities/sys/Customer"
import {CustomerInfoTypeRef} from "../api/entities/sys/CustomerInfo"
import {AccountingInfoTypeRef} from "../api/entities/sys/AccountingInfo"
import {logins} from "../api/main/LoginController"
import {NotAuthorizedError} from "../api/common/error/RestError"
import {getPriceItem} from "./PriceUtils"
import {formatPrice} from "./SubscriptionUtils"
import type {DialogHeaderBarAttrs} from "../gui/base/DialogHeaderBar"
import {DialogHeaderBar} from "../gui/base/DialogHeaderBar"

assertMainOrNode()

/**
 * Returns true if the order is accepted by the user, false otherwise.
 */
export function show(featureType: BookingItemFeatureTypeEnum, count: number, freeAmount: number, reactivate: boolean): Promise<boolean> {
    if (logins.isEnabled(FeatureType.HideBuyDialogs)) {
        return Promise.resolve(true)
    }
    return load(CustomerTypeRef, neverNull(logins.getUserController().user.customer)).then(customer => {
        if (customer.type === AccountType.PREMIUM && customer.canceledPremiumAccount) {
            return Dialog.error("subscriptionCancelledMessage_msg").return(false)
        } else {
            return worker.getPrice(featureType, count, reactivate).then(price => {
                if (!_isPriceChange(price, featureType)) {
                    return Promise.resolve(true)
                } else {

                    return load(CustomerInfoTypeRef, customer.customerInfo).then(customerInfo => {
                        return load(AccountingInfoTypeRef, customerInfo.accountingInfo)
                            .catch(NotAuthorizedError, e => {/* local admin */
                            })
                            .then(accountingInfo => {
                                if (accountingInfo && !accountingInfo.invoiceCountry) {
                                    return Dialog.confirm("enterPaymentDataFirst_msg").then(confirm => {
                                        if (confirm) {
                                            m.route.set("/settings/invoice")
                                        }
                                        return false
                                    })
                                } else {
                                    let buy = _isBuy(price, featureType)
                                    let orderField = new TextField("bookingOrder_label")
                                        .setValue(_getBookingText(price, featureType, count, freeAmount))
                                        .setDisabled()
                                    let buyField = (buy) ? new TextField("subscription_label",
                                        () => _getSubscriptionInfoText(price)).setValue(_getSubscriptionText(price))
                                        .setDisabled() : null
                                    let priceField = new TextField("price_label",
                                        () => _getPriceInfoText(price, featureType))
                                        .setValue(_getPriceText(price, featureType))
                                        .setDisabled()

                                    return new Promise(resolve => {
                                        let dialog: Dialog
                                        const doAction = res => {
                                            dialog.close()
                                            resolve(res)
                                        }

                                        let actionBarAttrs: DialogHeaderBarAttrs = {
                                            left: [{
                                                label: "cancel_action",
                                                click: () => doAction(false),
                                                type: ButtonType.Secondary
                                            }],
                                            right: [{
                                                label: buy ? "buy_action" : "order_action",
                                                click: () => doAction(true),
                                                type: ButtonType.Primary
                                            }],
                                            middle: () => lang.get("bookingSummary_label")
                                        }

                                        dialog = new Dialog(DialogType.EditSmall, {
                                            view: (): Children => [
                                                m(".dialog-header.plr-l", m(DialogHeaderBar, actionBarAttrs)),
                                                m(".plr-l.pb", m("", [
                                                    m(orderField),
                                                    buyField ? m(buyField) : null,
                                                    m(priceField),
                                                ]))
                                            ]
                                        }).setCloseHandler(() => doAction(false)).show()
                                    })
                                }
                            })
                    })
                }
            })
        }
    })
}

function _getBookingText(price: PriceServiceReturn, featureType: NumberString, count: number, freeAmount: number): string {
    if (_isSinglePriceType(price.currentPriceThisPeriod, price.futurePriceNextPeriod, featureType)) {
        if (featureType === BookingItemFeatureType.Users) {
            if (count > 0) {
	            let additionalFeatures = []
                if (_getPriceFromPriceData(price.futurePriceNextPeriod, BookingItemFeatureType.Branding) > 0) {
                	additionalFeatures.push(lang.get("whitelabel_label"))
                }
	            if (_getPriceFromPriceData(price.futurePriceNextPeriod, BookingItemFeatureType.Sharing) > 0) {
		            additionalFeatures.push(lang.get("sharingFeature_label"))
	            }
                if (additionalFeatures.length > 0) {
                    return count + " " + lang.get("bookingItemUsersIncluding_label") + " " + additionalFeatures.join(", ")
                } else {
                    return count + " " + lang.get("bookingItemUsers_label")
                }
            } else {
                return lang.get("cancelUserAccounts_label", {"{1}": Math.abs(count)})
            }


        } else if (featureType === BookingItemFeatureType.Branding) {
            if (count > 0) {
                return lang.get("whitelabelBooking_label", {"{1}": neverNull(getPriceItem(price.futurePriceNextPeriod, BookingItemFeatureType.Branding)).count})
            } else {
                return lang.get("cancelWhitelabelBooking_label", {"{1}": neverNull(getPriceItem(price.currentPriceNextPeriod, BookingItemFeatureType.Branding)).count})
            }
        } else if (featureType === BookingItemFeatureType.Sharing) {
	        if (count > 0) {
		        return lang.get("sharingBooking_label", {"{1}": neverNull(getPriceItem(price.futurePriceNextPeriod, BookingItemFeatureType.Sharing)).count})
	        } else {
		        return lang.get("cancelSharingBooking_label", {"{1}": neverNull(getPriceItem(price.currentPriceNextPeriod, BookingItemFeatureType.Sharing)).count})
	        }
        } else if (featureType === BookingItemFeatureType.ContactForm) {
            if (count > 0) {
                return count + " " + lang.get("contactForm_label")
            } else {
                return lang.get("cancelContactForm_label")
            }
        } else if (featureType === BookingItemFeatureType.SharedMailGroup) {
            if (count > 0) {
                return count + " " + lang.get((count === 1) ? "sharedMailbox_label" : "sharedMailboxes_label")
            } else {
                return lang.get("cancelSharedMailbox_label")
            }
        } else if (featureType === BookingItemFeatureType.LocalAdminGroup) {
            if (count > 0) {
                return count + " " + lang.get((count === 1) ? "localAdminGroup_label" : "localAdminGroups_label")
            } else {
                return lang.get("cancelLocalAdminGroup_label")
            }
        } else {
            return ""
        }
    } else {
        let item = getPriceItem(price.futurePriceNextPeriod, featureType)
        let newPackageCount = 0
        if (item != null) {
            newPackageCount = item.count
        }
        let visibleAmount = Math.max(count, freeAmount)
        if (featureType === BookingItemFeatureType.Storage) {
            if (count < 1000) {
                return lang.get("storageCapacity_label") + " " + visibleAmount + " GB"
            } else {
                return lang.get("storageCapacity_label") + " " + (visibleAmount / 1000) + " TB"
            }
        } else if (featureType === BookingItemFeatureType.Users) {
            if (count > 0) {
                return lang.get("packageUpgradeUserAccounts_label", {"{1}": newPackageCount})
            } else {
                return lang.get("packageDowngradeUserAccounts_label", {"{1}": newPackageCount})
            }
        } else if (featureType === BookingItemFeatureType.Alias) {
            return visibleAmount + " " + lang.get("mailAddressAliases_label")
        } else {
            return "" // not possible
        }
    }
}

function _getSubscriptionText(price: PriceServiceReturn): string {
    if (neverNull(price.futurePriceNextPeriod).paymentInterval === "12") {
        return lang.get("pricing.yearly_label") + ', ' + lang.get('automaticRenewal_label')
    } else {
        return lang.get("pricing.monthly_label") + ', ' + lang.get('automaticRenewal_label')
    }
}

function _getSubscriptionInfoText(price: PriceServiceReturn): string {
    return lang.get("endOfSubscriptionPeriod_label", {"{1}": formatDate(price.periodEndDate)})
}

function _getPriceText(price: PriceServiceReturn, featureType: NumberString): string {
    let netGrossText = neverNull(price.futurePriceNextPeriod).taxIncluded ? lang.get("gross_label") : lang.get("net_label")
    let periodText = (neverNull(price.futurePriceNextPeriod).paymentInterval === "12")
        ? lang.get('pricing.perYear_label') : lang.get('pricing.perMonth_label')
    let futurePriceNextPeriod = _getPriceFromPriceData(price.futurePriceNextPeriod, featureType)
    let currentPriceNextPeriod = _getPriceFromPriceData(price.currentPriceNextPeriod, featureType)

    if (_isSinglePriceType(price.currentPriceThisPeriod, price.futurePriceNextPeriod, featureType)) {
        let priceDiff = futurePriceNextPeriod - currentPriceNextPeriod
        return formatPrice(priceDiff, true) + " " + periodText + " (" + netGrossText + ")"
    } else {
        return formatPrice(futurePriceNextPeriod, true) + " " + periodText + " (" + netGrossText + ")"
    }
}

function _getPriceInfoText(price: PriceServiceReturn, featureType: NumberString): string {
    if (_isUnbuy(price, featureType)) {
        return lang.get("priceChangeValidFrom_label", {"{1}": formatDate(price.periodEndDate)})
    } else if (price.currentPeriodAddedPrice && Number(price.currentPeriodAddedPrice) >= 0) {
        return lang.get("priceForCurrentAccountingPeriod_label", {"{1}": formatPrice(Number(price.currentPeriodAddedPrice), true)})
    } else {
        return ""
    }
}

function _isPriceChange(price: PriceServiceReturn, featureType: NumberString): boolean {
    return (_getPriceFromPriceData(price.currentPriceNextPeriod, featureType)
        !== _getPriceFromPriceData(price.futurePriceNextPeriod, featureType))
}

function _isBuy(price: PriceServiceReturn, featureType: NumberString): boolean {
    return (_getPriceFromPriceData(price.currentPriceNextPeriod, featureType)
        < _getPriceFromPriceData(price.futurePriceNextPeriod, featureType))
}

function _isUnbuy(price: PriceServiceReturn, featureType: NumberString): boolean {
    return (_getPriceFromPriceData(price.currentPriceNextPeriod, featureType)
        > _getPriceFromPriceData(price.futurePriceNextPeriod, featureType))
}

function _isSinglePriceType(currentPriceData: ?PriceData, futurePriceData: ?PriceData, featureType: NumberString): boolean {
    let item = getPriceItem(futurePriceData, featureType) || getPriceItem(currentPriceData, featureType)
    return neverNull(item).singleType
}


/**
 * Returns the price for the feature type from the price data if available, otherwise 0.
 */
function _getPriceFromPriceData(priceData: ?PriceData, featureType: NumberString): number {
    let item = getPriceItem(priceData, featureType)
    let itemPrice = item ? Number(item.price) : 0
    if (featureType === BookingItemFeatureType.Users) {
        itemPrice += _getPriceFromPriceData(priceData, BookingItemFeatureType.Branding)
	    itemPrice += _getPriceFromPriceData(priceData, BookingItemFeatureType.Sharing)
    }
    return itemPrice
}
